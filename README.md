# ReachInbox — Full-Stack Email Job Scheduler

A production-shaped email scheduling service: BullMQ + Redis delayed jobs (no cron), Postgres for durable state, Elasticsearch for search, a live Bull-Board queue dashboard, Redis-backed multi-worker-safe rate limiting, real Slack notifications, and a Next.js dashboard behind real Google OAuth.

```
reachinbox/
├── backend/               Express + TypeScript API + BullMQ worker
│   ├── Dockerfile         multi-stage: build TS + Prisma client, then run
│   └── .dockerignore
├── frontend/              Next.js + Tailwind dashboard
│   ├── Dockerfile         multi-stage: production Next.js standalone build
│   └── .dockerignore
├── .env.example           compose-level config (ports, DB creds, OAuth)
└── docker-compose.yml     postgres + redis + elasticsearch + backend + worker + frontend
```

---

## 1. Quick start

### 1.0 Full stack, one command (recommended)

The entire app — Postgres, Redis, Elasticsearch, the backend API, the BullMQ
worker, and the production Next.js frontend — starts with a single command
from the repo root:

```bash
cp .env.example .env   # optional: customize ports/creds, see comments inside
docker compose up --build
```

That's it. Compose builds the backend image once and reuses it for both the
`backend` and `worker` services, runs `prisma migrate deploy` automatically
before the API starts, waits for Postgres/Redis/Elasticsearch to report
healthy before starting the backend, and waits for the backend to report
healthy before starting the worker and frontend.

Once it's up:

| Service | URL | Notes |
|---|---|---|
| **Frontend (dashboard)** | http://localhost:3000 | Production Next.js build |
| **Backend API** | http://localhost:4000 | Express API, health check at `/health` |
| **Bull-Board (queue dashboard)** | http://localhost:4000/admin/queues | Requires login (session-gated) |
| **Postgres** | `localhost:5432` | user/db `reachinbox` / `reachinbox` by default — see `.env.example` |
| **Redis** | `localhost:6379` | AOF persistence enabled |
| **Elasticsearch** | http://localhost:9200 | Single-node, security disabled for local dev |

Google/Slack OAuth are optional — without credentials set in `.env`, login
and Slack notifications are simply disabled rather than crashing (see §3 to
enable them). All ports and credentials are configurable via the root
`.env` file (copy from `.env.example`); nothing is hardcoded in
`docker-compose.yml`.

To stop everything: `docker compose down` (add `-v` to also drop the
Postgres/Redis/Elasticsearch volumes and start fresh next time).

Useful commands:

```bash
docker compose logs -f backend worker   # tail API + worker logs
docker compose ps                        # see health status of every service
docker compose config                    # print the fully-resolved config
```

### 1.1 Manual / local dev (no Docker for the app itself)

If you'd rather run the Node processes directly on your machine (e.g. for
faster iteration) while still using Docker for infra only, start just the
three data services and skip `backend`/`worker`/`frontend`:

```bash
docker compose up -d postgres redis elasticsearch
```

### 1.2 Backend

```bash
cd backend
cp .env.example .env      # fill in Google/Slack creds (see §3)
npm install
npm run prisma:migrate    # creates tables
npm run seed:es           # creates the Elasticsearch index
npm test                  # runs the unit test suite (no live infra required)

# two processes — the API server and the queue worker are separate on purpose,
# so you can scale/restart them independently, same as you would in prod
npm run dev                # terminal 1: Express API on :4000
npm run worker:dev         # terminal 2: BullMQ worker
```

API: `http://localhost:4000`
Bull-Board (live queue dashboard): `http://localhost:4000/admin/queues`

### 1.3 Frontend

```bash
cd frontend
cp .env.local.example .env.local   # or just export NEXT_PUBLIC_API_URL
npm install
npm run dev
```

Frontend: `http://localhost:3000`

---

## 2. Ethereal Email setup

You don't need to manually sign up. When a user clicks **"+ Add sender"** in the Compose modal, the backend calls `nodemailer.createTestAccount()` (`src/services/mailer.ts`), which mints a **fresh Ethereal SMTP inbox on the fly** and stores its credentials on a `Sender` row. Every email sent through that sender includes an Ethereal preview URL in the server logs (`previewUrl` field) — use that in your demo video instead of a real inbox screenshot.

If you'd rather use a fixed account, create one manually at https://ethereal.email and set `smtpUser`/`smtpPass` directly on a `Sender` row (or extend the `/api/senders` route to accept explicit credentials).

---

## 3. OAuth setup

### Google (required for login)
1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → **Create OAuth client ID** → Web application.
2. Authorized redirect URI: `http://localhost:4000/api/auth/google/callback`
3. Copy Client ID/Secret into `backend/.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Slack (required for rate-limit notifications)
1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch.
2. OAuth & Permissions → Redirect URL: `http://localhost:4000/api/slack/callback`
3. Bot Token Scopes: `chat:write`, `incoming-webhook`.
4. Copy Client ID/Secret into `backend/.env` as `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`.
5. In the dashboard, click **"Connect Slack"** — this is a real OAuth `authorize` redirect, not a mock. The resulting bot token / webhook URL is stored per-user in `SlackIntegration`.

If a user never connects Slack, rate-limit hits are simply logged and skipped (`services/slack.ts`) — no crash. Connecting later starts notifications immediately, since the integration is looked up fresh from the DB on every rate-limit hit (no caching, no redeploy needed).

---

## 4. Architecture overview

### 4.1 How scheduling works (no cron)

- `POST /api/campaigns` parses the uploaded CSV/TXT, creates one `ScheduledEmail` row per recipient, and calls `enqueueEmailJob()` for each.
- `enqueueEmailJob` adds a **BullMQ delayed job** (`emailQueue.add(..., { delay, jobId })`). BullMQ persists this in Redis as an entry in a sorted set keyed by run-time; its internal scheduler (not our code, not `setInterval`, not OS cron) moves the job into the active queue the moment it's due.
- The `Worker` process in `emailWorker.ts` pulls jobs off the queue with a **configurable `concurrency`** (`WORKER_CONCURRENCY` env var) and executes the send.
- **Idempotency**: `jobId` is always set to the `ScheduledEmail.id`. BullMQ guarantees at most one job per `jobId` per queue — calling `add()` again with the same id is a no-op against the existing job. That covers the *enqueue* side. The *send* side is separately protected by a `SendLedger` row with a unique constraint on `scheduledEmailId` — the worker `INSERT`s into it right before calling SMTP, and if two workers ever raced to the same job, only one insert succeeds; the loser backs off without sending. This means "don't send the same email twice" holds even across a mid-send crash and retry.

### 4.2 Persistence across restarts

- Redis (BullMQ's backing store) is a separate durable process — a server/worker restart alone does **not** lose delayed jobs; they're already sitting in Redis waiting for their timestamp.
- `services/recovery.ts` runs once on server boot as a defensive second layer: it scans Postgres for any `ScheduledEmail` row still in a pending-ish status whose `bullJobId` no longer resolves to a real BullMQ job (e.g. Redis itself was wiped independently of Postgres), and re-enqueues it. Because it reuses the row's own id as the `jobId`, this is naturally idempotent — it can never create a duplicate even if it fires spuriously.
- Demo scenario: schedule an email a few minutes out → `docker compose stop` the worker (or kill the process) → restart it → the email still sends at the original time, not immediately and not never.

### 4.3 Rate limiting & concurrency

Two independent controls, both enforced with **atomic Redis Lua scripts** (`services/rateLimiter.ts`) so they're safe across multiple worker processes — never relying on in-memory counters:

1. **Hourly cap, scoped globally per sender** — key `rl:hour:{senderId}:{hourBucket}` (fixed wall-clock hour windows, not rolling; no `campaignId` in the key). A Lua script does a check-then-increment atomically, so two concurrent workers can never both claim the "last" slot in a window. This is deliberate: an SMTP mailbox's real hourly throughput limit belongs to the sender, not to any one campaign, so every campaign sending from the same `Sender` shares one counter — two campaigns from the same sender can no longer each independently exhaust a full hourly quota and together double the sender's real send rate. The limit value enforced is the `Sender`'s own `maxEmailsPerHour` (not the per-campaign `hourlyLimit` field — see §4.4). When the cap is hit, the job is **never dropped or failed**: the worker calls `job.moveToDelayed(nextWindowTimestamp, token)` — the BullMQ-documented way to push an *active* job into the future — then throws `DelayedError` so BullMQ treats the invocation as neither completed nor failed. Its DB status becomes `RATE_LIMITED_REQUEUED`, and a live Slack message is sent.

   *Earlier version of this code called `job.changeDelay()` on the job instance from inside its own processor. That's a real bug: `changeDelay()` only operates on jobs in the `waiting`/`delayed` state, and a job currently being processed is in the `active` state — calling it there is undefined/no-op behavior, not a working reschedule. Fixed by switching to `job.moveToDelayed(timestamp, token)` + `throw new DelayedError()`, which is BullMQ's actual supported pattern for this (see `docs.bullmq.io/patterns/process-step-jobs`) — verified against the installed `bullmq` package source, not just the docs.*

2. **Minimum delay between sends, scoped per (sender, campaign)** — key `rl:nextslot:{senderId}:{campaignId}`, storing the epoch-ms timestamp of the next allowed send. A Lua script atomically reads-and-advances this per attempt, so concurrent workers spread sends out rather than bursting.

`MAX_EMAILS_PER_HOUR`/`MIN_DELAY_MS` are env-configurable fallback defaults, used only to populate `Sender.maxEmailsPerHour`/`Sender.minDelayMs` when a `Sender` is first created. `WORKER_CONCURRENCY` is also env-configurable. The **effective hourly cap** for any given email is read from that email's `Sender` row (`maxEmailsPerHour`) at send time, shared across every campaign from that sender (see above). The **effective minimum delay** between sends is read from that email's own `Campaign` row (`delayMs`) — see §4.4 — so pacing stays campaign-specific even though the hourly quota does not.

**Trade-offs / simplifications, stated explicitly:**
- The hourly cap uses fixed clock-hour windows rather than a true rolling 60-minute window — simpler to reason about (and to explain "next available window") at the cost of allowing a small burst right at a window boundary.
- The hourly cap is aggregate per sender, not per campaign: running two campaigns concurrently from the same sender shares one hourly counter, by design, so together they can't exceed the sender's real configured throughput. `Campaign.hourlyLimit` still exists in the schema/API (kept as a required field for `POST /api/campaigns` so the endpoint's shape doesn't change), but it is **not** read by the worker and is no longer exposed as an editable Compose-modal field, since showing it would suggest it's an enforced per-campaign setting when it isn't. The number that actually gates sending is the sender's own `maxEmailsPerHour` (set when the sender is created).

### 4.4 Campaign-specific vs. sender-wide configuration

Each `Campaign` row stores its own `delayMs` (and, for future use, `hourlyLimit` — see the note above). The worker reads `delayMs` from the specific email's campaign relation to pace sends, and the Redis min-delay key is scoped by `senderId:campaignId`, so each campaign's cadence stays independent. The hourly cap, by contrast, is intentionally **not** campaign-scoped (see §4.3): it's read from the email's `Sender` row and shared by every campaign sending from that sender. **Composing a new campaign never mutates the `Sender` row** — an earlier version of this code updated `Sender.maxEmailsPerHour`/`Sender.minDelayMs` on every compose, which meant starting a second campaign from the same sender would silently change the rate limit applied to a first campaign still in flight. That's fixed: `Sender` only holds the values set when the sender was created; the worker reads the live `Sender` row for the hourly cap and the live `Campaign` row for the delay.

### 4.5 Search (Elasticsearch) & tenant isolation

Every `ScheduledEmail` create/status-change is mirrored into an Elasticsearch index (`services/searchIndex.ts`) via `indexEmail()`, including a `userId` field on every document. `GET /api/emails/search?q=&status=&senderId=` does a `multi_match` across subject/body/recipient — and `userId` is a **mandatory** term filter (not optional) in `searchEmails()`, always populated from the caller's own session, so one user can never see another user's indexed emails even if they guess or brute-force IDs. `SearchEmailsParams.userId` is a required field in the TypeScript signature specifically so this can't be silently omitted by a future caller. A search box with status filter chips (All/Scheduled/Sent/Failed) is wired into the dashboard so this feature is actually visible, not just present on the backend.

*Earlier version of this code had no `userId` field on ES documents or in the search query at all — any authenticated user could search and see any other user's subject lines/bodies/recipients via `/api/emails/search`. Fixed by denormalizing `userId` onto `ScheduledEmail` and every ES document, and making it a required, always-populated filter.*

Indexing failures are logged and swallowed — search is best-effort and must never block the send pipeline.

### 4.6 Delivery semantics — please read before assuming "exactly-once"

**Idempotency layer 1 (enqueue):** BullMQ `jobId = scheduledEmailId` guarantees at most one job per email in the queue. Solid, no caveats.

**Idempotency layer 2 (send):** a `SendLedger` row with a unique constraint on `scheduledEmailId`, inserted right before the SMTP call. This reliably prevents *concurrent* double sends — if two workers ever raced to process the same job, only one insert succeeds and the other backs off.

**What this does NOT guarantee:** true exactly-once delivery across an arbitrary crash. There is an unavoidable window between "the SMTP server accepted the message" and "we finish writing `SENT` to Postgres." If the process is killed in that exact window:
- The ledger row already exists, so any retry correctly refuses to re-send (no duplicate email) — good.
- But nothing ever writes `SENT`, so the row is stuck at `PROCESSING`, and the system doesn't actually know whether the email went out.

This makes the system **at-most-once-send, with a possible gap between "sent" and "recorded as sent."** True exactly-once delivery would require the SMTP provider to support idempotency keys on its accept path, which Ethereal/raw SMTP does not.

Rather than leave this invisible, `services/recovery.ts` runs `sweepStaleProcessingRows()` on every boot: rows stuck in `PROCESSING` for more than 10 minutes with no live BullMQ job behind them are checked against `SendLedger`. If a ledger row exists (ambiguous — may have already sent), the row is flipped to `FAILED` with an explicit note to verify manually, and is **never auto-resent**. If no ledger row exists (crash happened before any send attempt), it's safely reset to `SCHEDULED` and re-enqueued. This trades a small amount of manual-review overhead for never silently duplicating or silently losing an email.

### 4.7 Behavior under load (1000+ emails at once)

`POST /api/campaigns` pre-staggers each recipient's intended `scheduledAt` by `delayMs * index` at creation time rather than enqueuing everything with `delay: 0` — so 1,000 rows don't all fire in the same instant even before the rate limiter gets involved. The rate limiter then does the real enforcement: any sends that would exceed the hourly cap are pushed into the next hour window automatically via `job.moveToDelayed` (see §4.3), preserving relative order (same `jobId`, just a later delay) rather than being dropped.

---

## 5. Feature checklist

### Backend
- [x] API-driven scheduling → `POST /api/campaigns`
- [x] BullMQ delayed jobs, no cron
- [x] Multi-sender Ethereal SMTP sending
- [x] Elasticsearch indexing + search endpoint, **user-isolated** (`userId` mandatory filter)
- [x] Live Bull-Board dashboard (`/admin/queues`)
- [x] Restart-safe persistence + recovery sweep, **including a stale-PROCESSING sweep** for crash-mid-send ambiguity
- [x] Idempotent sends (BullMQ jobId + DB SendLedger unique constraint) — see §4.6 for exact guarantees
- [x] Configurable worker concurrency (`WORKER_CONCURRENCY`)
- [x] Configurable, **campaign-scoped** min delay between sends, plus a **sender-wide** hourly rate limit (shared across every campaign from the same sender, so one sender's real quota can't be doubled by running two campaigns at once — see §4.3)
- [x] Rate-limit overflow → correctly requeued via `job.moveToDelayed` + `DelayedError` (not `job.changeDelay`, which doesn't work on active jobs), never dropped
- [x] Real Slack OAuth + live notification on rate-limit hit, safe no-op when disconnected
- [x] Unit tests: rate limiter decision logic, CSV/TXT lead parsing, stale-job recovery sweep, auth middleware (`npm test`)
- [x] Real integration tests against live Postgres/Redis/BullMQ: retry-then-send, retry exhaustion, concurrent-processing idempotency, restart/recovery (`npm run test:integration` — see §8)

### Frontend
- [x] Real Google OAuth login → redirect to dashboard
- [x] Header with name/email/avatar + logout
- [x] Scheduled / Sent tabs
- [x] Compose modal: subject, body, CSV/TXT upload with live detected-email count, start time, delay (the enforced hourly cap is configured per-sender — see §4.3/§4.4 — not on the Compose form)
- [x] Scheduled table: email, subject, scheduled time, status, loading + empty states
- [x] Sent table: email, subject, sent time, status, loading + empty states
- [x] **Elasticsearch search bar** with status filter chips (All/Scheduled/Sent/Failed), debounced
- [x] Slack connect/disconnect from the header
- [x] Typed API client, reusable UI components, TypeScript throughout

---

## 6. Assumptions, shortcuts & trade-offs

- **No pixel-perfect Figma match** — the assignment links a Figma file this environment couldn't open; the frontend implements every described screen/element (header, tabs, compose modal, tables, states, search) with original styling rather than matching exact spacing/colors. This is the most visible remaining gap — swap in the real design tokens if you have Figma access, or treat it as the highest-value thing to fix before submitting if visual fidelity is weighted.
- **Session auth** uses a signed `cookie-session` cookie rather than JWTs/Redis-backed sessions — simpler for this scope, fine for a single-instance demo, would move to a shared session store for multi-instance deployment.
- **Bull-Board is not auth-gated** in this build (spec asked for "live visibility", not access control) — add `requireAuth` or basic-auth in front of `/admin/queues` before deploying anywhere public.
- **Rate limits are per (sender, campaign), not aggregated per sender** — see §4.3's trade-off note. Two campaigns running concurrently from the same sender are each independently capped, not capped in aggregate. Documented, not silently assumed away.
- **Hourly rate limit uses fixed clock-hour windows**, not a rolling window (see §4.3) — a documented, deliberate simplification.
- **CSV parsing** accepts any file where a cell matches an email regex, so it tolerates headers, extra columns, or a bare newline-separated list without requiring a specific CSV schema.
- **No pagination yet** on the scheduled/sent tables (capped at 200 rows server-side) — fine for a demo; would add cursor-based pagination for real scale.
- **Elasticsearch is best-effort**: if it's down, scheduling/sending still works; only search degrades.
- **Delivery is at-most-once-send with a possible reporting gap, not exactly-once** — see §4.6 for the precise guarantee and why. This is a fundamental limit of coordinating a stateless retry system with a non-idempotent SMTP accept path, not something a quick fix resolves; it's called out explicitly rather than overclaimed.
- **Unit tests cover pure logic and mocked dependencies** (`npm test`) — rate-limiter decisions, CSV parsing, the recovery sweep's branches, auth middleware — without needing live Redis/Postgres/Elasticsearch. **Real integration tests** (`npm run test:integration`, §8) cover retry-then-send, retry exhaustion, concurrent-processing idempotency, and restart/recovery against a live Postgres + Redis + BullMQ, with only SMTP/ES/Slack mocked. What's still missing: a true end-to-end test across genuinely separate worker processes (see §8's "Known gap"), and the frontend has no automated tests at all — the manual walkthrough in §1 substitutes for both.

---

## 7. Environment variables reference

See `backend/.env.example` for the full list with comments. Nothing is hardcoded — every limit (`MAX_EMAILS_PER_HOUR`, `MIN_DELAY_MS`, `WORKER_CONCURRENCY`) and every credential is read from env via a single validated `src/config/env.ts`.

---

## 8. Integration tests (real infra)

`npm test` (§1.2) is the unit suite: pure logic against mocked Prisma/Redis/BullMQ/SMTP/ES/Slack, no live infra required. Alongside it, `backend/tests/integration/` is a **real** integration suite — real Postgres via Prisma, real Redis, and a real BullMQ `Queue`/`Worker` pair. Only the genuinely external services are mocked per-test-file: outbound SMTP (`services/mailer.ts`), Elasticsearch indexing (already covered in isolation by `tests/productionReadiness.test.ts`), and Slack notifications.

### Running it

```bash
# 1. Start real infra (from the repo root)
docker compose up -d postgres redis

# 2. Migrate the database this suite will run against
cd backend
npm install
npm run prisma:deploy      # or `npm run prisma:migrate` on a fresh DB

# 3. Run the integration suite
npm run test:integration
```

`npm run test:integration` runs `vitest` against `vitest.integration.config.ts`, which is separate from the unit config (`vitest.config.ts` explicitly excludes `tests/integration/`) so `npm test` never needs live infra and the integration suite never accidentally runs without it.

**Use a disposable/dedicated Postgres for this**, not a database with real production or personal data. The restart/recovery tests exercise `recoverUnfinishedJobs()`/`sweepStaleProcessingRows()`, which — by design, matching production behavior — sweep *every* `PENDING`/`SCHEDULED`/`RATE_LIMITED_REQUEUED`/stale-`PROCESSING` row in the table, not just rows the test created. Each test file creates its own fixtures (fresh UUIDs) and cleans them up afterwards, but this global-sweep behavior is why the suite must run against an isolated database to stay deterministic. Test files run serially (`fileParallelism: false`) for the same reason — they share one live Postgres/Redis instance.

### What's covered

| Scenario | File | Verifies |
|---|---|---|
| Retry, eventually sent | `retryEventuallySent.integration.test.ts` | A transient SMTP failure triggers a real BullMQ retry with exponential backoff honored; the row is never left `FAILED` in between; final status is `SENT` with exactly one `SendLedger` row. |
| Retry exhaustion | `retryExhaustion.integration.test.ts` | Every send attempt fails; BullMQ exhausts the configured `attempts`; final Postgres status is `FAILED` with `lastError` populated; no `SendLedger` row is left behind. |
| Idempotency | `idempotency.integration.test.ts` | Two concurrent `processEmailJob` calls for the same row race on Postgres's real unique constraint on `SendLedger.scheduledEmailId`; only one SMTP send happens; the loser exits without throwing. |
| Restart/recovery | `restartRecovery.integration.test.ts` | (a) A `SCHEDULED` row whose BullMQ job was lost (simulated Redis/restart data loss) is safely re-enqueued exactly once and still completes; (b) a stale `PROCESSING` row with no `SendLedger` claim is safely re-enqueued and completes; (c) a stale `PROCESSING` row that *does* have a `SendLedger` claim (ambiguous crash mid-send) is marked `FAILED` and is deliberately **not** re-enqueued or resent. |

The existing unit tests for scheduling (`emailWorker.test.ts`'s attempt-status logic), rate limiting (`rateLimiter.test.ts`), authorization (`auth.test.ts`, `bullBoardAuth.test.ts`), and Elasticsearch isolation (`productionReadiness.test.ts`) are unchanged.

### Known gap

These tests run everything inside a single Node process — `Promise.all([processEmailJob(...), processEmailJob(...)])` for the idempotency test, one real BullMQ `Worker` per scenario for the others. That's enough to exercise the real Postgres unique constraint and real BullMQ retry/backoff/persistence mechanics, but it doesn't stand up two genuinely separate OS processes/containers racing against each other. The manual walkthrough in §1, or a future multi-worker Docker Compose scenario, is what would close that last gap.
