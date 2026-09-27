import { randomUUID } from "crypto";
import { prisma } from "../../src/lib/prisma";
import { redis } from "../../src/lib/redis";
import type { EmailJobData } from "../../src/queues/emailQueue";

/**
 * These helpers back the *real integration* tests in this folder: unlike
 * tests/emailWorker.test.ts and tests/recovery.test.ts (which mock Prisma
 * and Redis to test pure logic), everything here talks to an actual
 * Postgres and Redis instance. Only the outbound SMTP call
 * (services/mailer.ts), Elasticsearch indexing (services/searchIndex.ts,
 * already covered in isolation by tests/productionReadiness.test.ts) and
 * the Slack webhook are mocked per-test-file, since those are genuinely
 * external services with their own dedicated coverage elsewhere.
 *
 * Every fixture below is created with a fresh UUID (sender/campaign/user),
 * so tests in this folder can run against a shared, persistent dev/CI
 * database without colliding with each other or with real data - and each
 * test cleans up its own rows in `afterEach`/`afterAll`.
 */

export interface Fixtures {
  userId: string;
  senderId: string;
  campaignId: string;
}

export async function createFixtures(opts?: {
  maxEmailsPerHour?: number;
  delayMs?: number;
  hourlyLimit?: number;
}): Promise<Fixtures> {
  const suffix = randomUUID();

  const user = await prisma.user.create({
    data: { email: `integration-${suffix}@example.test` },
  });

  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      label: `Integration Sender ${suffix}`,
      smtpHost: "smtp.integration-test.invalid",
      smtpPort: 587,
      smtpUser: "integration-user",
      smtpPass: "integration-pass",
      // High enough that rate limiting never interferes with these tests -
      // rate limiting has its own dedicated coverage in rateLimiter.test.ts.
      maxEmailsPerHour: opts?.maxEmailsPerHour ?? 100000,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      subject: "Integration test campaign",
      bodyHtml: "<p>integration test</p>",
      startTime: new Date(),
      delayMs: opts?.delayMs ?? 0,
      hourlyLimit: opts?.hourlyLimit ?? 100000,
    },
  });

  return { userId: user.id, senderId: sender.id, campaignId: campaign.id };
}

export async function createScheduledEmail(
  fixtures: Fixtures,
  overrides?: { status?: string; scheduledAt?: Date },
) {
  return prisma.scheduledEmail.create({
    data: {
      campaignId: fixtures.campaignId,
      senderId: fixtures.senderId,
      userId: fixtures.userId,
      recipient: `recipient-${randomUUID()}@example.test`,
      subject: "Hello from integration test",
      bodyHtml: "<p>hi</p>",
      scheduledAt: overrides?.scheduledAt ?? new Date(),
      status: (overrides?.status as any) ?? "SCHEDULED",
    },
  });
}

export function toJobData(row: {
  id: string;
  senderId: string;
  recipient: string;
  subject: string;
  bodyHtml: string;
}): EmailJobData {
  return {
    scheduledEmailId: row.id,
    senderId: row.senderId,
    recipient: row.recipient,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
  };
}

/** Minimal fake BullMQ Job, for tests that call processEmailJob directly
 * (rather than through a real Worker) to control attemptsMade precisely or
 * to fire two concurrent invocations against the same row. */
export function makeFakeJob(data: EmailJobData, attemptsMade = 0, attempts = 5) {
  return {
    data,
    attemptsMade,
    opts: { attempts },
    moveToDelayed: async () => {},
  } as any;
}

export async function cleanupFixtures(fixtures: Fixtures) {
  // SendLedger has no declared relation back to ScheduledEmail (just a bare
  // unique scheduledEmailId column), so it can't be deleted via a nested
  // relation filter - look up the row ids for this campaign first.
  const rows = await prisma.scheduledEmail.findMany({
    where: { campaignId: fixtures.campaignId },
    select: { id: true },
  });
  const rowIds = rows.map((r) => r.id);
  if (rowIds.length) {
    await prisma.sendLedger
      .deleteMany({ where: { scheduledEmailId: { in: rowIds } } })
      .catch(() => {});
  }
  await prisma.scheduledEmail
    .deleteMany({ where: { campaignId: fixtures.campaignId } })
    .catch(() => {});
  await prisma.campaign.deleteMany({ where: { id: fixtures.campaignId } }).catch(() => {});
  await prisma.sender.deleteMany({ where: { id: fixtures.senderId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: fixtures.userId } }).catch(() => {});
}

/** Clears the Redis rate-limiter keys this sender may have touched, so a
 * test file never leaks a counter into a later run. Scoped by senderId
 * (a fresh UUID per test), so this can never touch another test's keys. */
export async function flushRateLimitKeysFor(senderId: string) {
  const keys = await redis.keys(`rl:*${senderId}*`);
  if (keys.length) await redis.del(...keys);
}
