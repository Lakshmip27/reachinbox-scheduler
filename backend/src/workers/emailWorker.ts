import { Worker, Job, DelayedError } from "bullmq";
import { createRedisConnection } from "../lib/redis";
import { EMAIL_QUEUE_NAME, EmailJobData } from "../queues/emailQueue";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { logger } from "../config/logger";
import {
  checkAndConsumeHourlySlot,
  reserveSendSlot,
} from "../services/rateLimiter";
import { sendEmail } from "../services/mailer";
import { indexEmail } from "../services/searchIndex";
import { notifyRateLimitHit } from "../services/slack";
import { verifyProductionInfrastructure, ProductionDependencyError } from "../lib/productionReadiness";

/**
 * This file is the "no cron" scheduling story in practice:
 *
 * - Jobs sit in Redis as BullMQ *delayed* jobs (added in emailQueue.ts with
 *   `delay: runAt - now`). BullMQ's own internal delayed-job scanner (a
 *   Redis sorted set + BRPOPLPUSH-style blocking pop) moves them into the
 *   active queue when their time comes - this is not a setInterval/cron
 *   loop we wrote, it's BullMQ's persisted scheduler.
 * - This Worker process is what actually executes them. `concurrency`
 *   controls how many jobs this worker pulls off the queue in parallel.
 * - Every processor run re-derives everything it needs from Postgres by
 *   scheduledEmailId, so a worker restart mid-job just means BullMQ retries
 *   the job (its state lives in Redis) and the processor re-reads current
 *   DB state - nothing is held only in memory.
 *
 * DELIVERY SEMANTICS - read before calling this "exactly-once":
 *
 * `SendLedger` (a unique constraint on scheduledEmailId, inserted right
 * before the SMTP call) reliably prevents *concurrent* double sends: if two
 * workers ever raced to process the same job, only one insert succeeds and
 * the other backs off. That part is solid.
 *
 * What it does NOT solve is the crash window between "the SMTP server
 * accepted the message" and "we finished writing SENT to Postgres". If the
 * process is killed in that exact window:
 *   - The ledger row exists (we inserted it before sending), so a retry of
 *     this same job will see the claim and skip re-sending - correctly
 *     avoiding a duplicate email.
 *   - But the ScheduledEmail row is left stuck at PROCESSING forever,
 *     because nothing ever gets to write SENT. The email genuinely went
 *     out, but our system doesn't know that.
 * This is therefore an AT-MOST-ONCE-SEND / POSSIBLY-UNDER-REPORTED system,
 * not a provably exactly-once one - true exactly-once delivery across an
 * arbitrary crash would require the SMTP provider to support idempotency
 * keys on its own accept path, which Ethereal/raw SMTP does not.
 *
 * `services/recovery.ts` sweeps stale PROCESSING rows on boot and flips
 * them to FAILED with a note to verify manually, specifically so this
 * ambiguity surfaces as a visible, actionable row instead of silently
 * disappearing. See README §4.6 for the full write-up.
 */
// Extracted as a standalone named export (rather than inlined as the
// anonymous processor passed to `new Worker(...)` below) purely so it can
// be unit tested directly - calling it does not touch Redis/BullMQ at all,
// only Prisma/mailer/rate-limiter/search-index, all of which are mocked in
// tests/emailWorker.test.ts. Behavior is unchanged: `new Worker(...)` below
// still wires this up exactly as before.
export async function processEmailJob(job: Job<EmailJobData>, token?: string) {
  const { scheduledEmailId, senderId, recipient, subject, bodyHtml } = job.data;

  const emailRow = await prisma.scheduledEmail.findUnique({
    where: { id: scheduledEmailId },
    include: { sender: true, campaign: true },
  });

  if (!emailRow) {
    logger.warn(
      { scheduledEmailId },
      "ScheduledEmail row missing - skipping job",
    );
    return;
  }

  // Idempotency guard #1: if it's already sent (e.g. this job is a retry
  // that actually succeeded before crashing on the DB write), stop here.
  if (emailRow.status === "SENT") {
    logger.info(
      { scheduledEmailId },
      "Already sent - skipping duplicate processing",
    );
    return;
  }

  await prisma.scheduledEmail.update({
    where: { id: scheduledEmailId },
    data: { status: "PROCESSING" },
  });

  // Hourly cap is scoped GLOBALLY per sender (key = senderId only, no
  // campaignId) - see rateLimiter.ts. This is deliberate: an SMTP
  // sender's real-world hourly throughput limit is a property of the
  // sender/mailbox itself, not of any one campaign, so two campaigns
  // sending from the same Sender must share a single counter or the
  // sender's true limit could be exceeded by running them concurrently.
  // The limit value enforced is therefore the Sender's own
  // maxEmailsPerHour, not the per-campaign hourlyLimit field.
  const hourlyLimiterKey = senderId;
  const hourlyLimit = emailRow.sender.maxEmailsPerHour;

  // Minimum delay pacing, by contrast, stays scoped per (sender, campaign)
  // - each campaign's own configured send cadence is independent and this
  // is unaffected by the hourly-quota fix above.
  const minDelayLimiterKey = `${senderId}:${emailRow.campaignId}`;
  const minDelayMs = emailRow.campaign.delayMs;

  // --- Rate limit check #1: hourly cap (global per sender) ---
  const hourlyCheck = await checkAndConsumeHourlySlot(
    hourlyLimiterKey,
    hourlyLimit,
  );

  if (!hourlyCheck.allowed && hourlyCheck.nextWindowStart) {
    // BUG THIS FIXES: a job being processed by this callback is in BullMQ's
    // *active* state, not *waiting/delayed* - job.changeDelay() only works
    // on waiting/delayed jobs and throws (or silently no-ops, depending on
    // version) when called on an active one. The documented-safe way to
    // push an *active* job back into the future is job.moveToDelayed(),
    // which requires the worker's lock `token`, immediately followed by
    // throwing DelayedError so BullMQ knows this invocation ended because
    // the job was intentionally postponed rather than failed or completed.
    // See: https://docs.bullmq.io/patterns/process-step-jobs
    const nextRun = new Date(hourlyCheck.nextWindowStart);

    await job.moveToDelayed(hourlyCheck.nextWindowStart, token);

    await prisma.scheduledEmail.update({
      where: { id: scheduledEmailId },
      data: { status: "RATE_LIMITED_REQUEUED", scheduledAt: nextRun },
    });

    await indexEmail({
      scheduledEmailId,
      userId: emailRow.userId,
      recipient,
      subject,
      bodyHtml,
      status: "RATE_LIMITED_REQUEUED",
      senderId,
      campaignId: emailRow.campaignId,
      scheduledAt: nextRun,
    });

    await notifyRateLimitHit({
      userId: emailRow.campaign.userId,
      senderLabel: emailRow.sender.label,
      hourlyLimit,
      nextWindowStart: hourlyCheck.nextWindowStart,
    });

    logger.info(
      { scheduledEmailId, senderId, nextRun },
      "Hourly rate limit hit - rescheduled to next window",
    );

    // Signals to BullMQ "this job was moved, not completed and not
    // failed" - it must be thrown, not returned, or BullMQ will still try
    // to mark the job completed on top of the moveToDelayed we just did.
    throw new DelayedError();
  }

  // --- Rate limit check #2: minimum delay spacing between sends ---
  const reservedAt = await reserveSendSlot(minDelayLimiterKey, minDelayMs);
  const waitMs = reservedAt - Date.now();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // Idempotency guard #2: durable, DB-level lock via unique constraint.
  // See the "Delivery semantics" note below and in the README - this
  // prevents *concurrent double sends* but does not make delivery
  // provably exactly-once across an arbitrary crash; read that note
  // before treating "idempotent" as "exactly-once".
  try {
    await prisma.sendLedger.create({ data: { scheduledEmailId } });
  } catch (err) {
    logger.warn(
      { scheduledEmailId },
      "Send already claimed by another worker - skipping",
    );
    return;
  }

  try {
    const { previewUrl } = await sendEmail(
      {
        id: emailRow.sender.id,
        smtpHost: emailRow.sender.smtpHost,
        smtpPort: emailRow.sender.smtpPort,
        smtpUser: emailRow.sender.smtpUser,
        smtpPass: emailRow.sender.smtpPass,
      },
      recipient,
      subject,
      bodyHtml,
    );

    const sentAt = new Date();
    await prisma.scheduledEmail.update({
      where: { id: scheduledEmailId },
      data: { status: "SENT", sentAt },
    });

    await indexEmail({
      scheduledEmailId,
      userId: emailRow.userId,
      recipient,
      subject,
      bodyHtml,
      status: "SENT",
      senderId,
      campaignId: emailRow.campaignId,
      scheduledAt: emailRow.scheduledAt,
      sentAt,
    });

    logger.info({ scheduledEmailId, recipient, previewUrl }, "Email sent");
  } catch (err: any) {
    // Sending failed after we claimed the ledger slot - remove the claim
    // so a BullMQ retry (see attempts/backoff in emailQueue.ts) can
    // actually resend rather than being blocked by our own idempotency guard.
    // NOTE: this delete is itself part of the crash window discussed in
    // the "Delivery semantics" note - see README §4.6.
    await prisma.sendLedger
      .delete({ where: { scheduledEmailId } })
      .catch(() => {});

    // BUG THIS FIXES: this catch always ran on EVERY failed send attempt,
    // including ones BullMQ is about to automatically retry (see
    // `attempts`/`backoff` in emailQueue.ts) - so a job that failed once
    // and then succeeded on retry would still have a permanent FAILED row
    // sitting in the DB from the first attempt, alongside (or instead of,
    // depending on write ordering) the eventual SENT row.
    //
    // BullMQ decides whether to retry using the exact same condition its
    // own Job#shouldRetryJob uses internally: `attemptsMade + 1 <
    // opts.attempts`. `attemptsMade` here is still the *pre*-this-attempt
    // count (BullMQ only increments it once it processes this throw), so
    // `attemptsMade + 1` is this attempt's 1-based attempt number and the
    // job has attempts left iff that number is less than the configured
    // max. Mirroring that condition here - rather than guessing - is what
    // lets us tell an intermediate failure (more retries queued) apart
    // from the final one (no retries left, permanently FAILED).
    const maxAttempts = job.opts.attempts ?? 1;
    const attemptNumber = job.attemptsMade + 1;
    const isFinalAttempt = attemptNumber >= maxAttempts;

    const status = isFinalAttempt ? "FAILED" : "SCHEDULED";

    await prisma.scheduledEmail.update({
      where: { id: scheduledEmailId },
      data: {
        status,
        // Preserve retry/attempt info regardless of whether this is the
        // final attempt, so the row always reflects how many times we've
        // tried and why the most recent attempt failed.
        attempts: { increment: 1 },
        lastError: String(err?.message ?? err),
      },
    });

    await indexEmail({
      scheduledEmailId,
      userId: emailRow.userId,
      recipient,
      subject,
      bodyHtml,
      status,
      senderId,
      campaignId: emailRow.campaignId,
      scheduledAt: emailRow.scheduledAt,
    });

    if (isFinalAttempt) {
      logger.error(
        { scheduledEmailId, attemptNumber, maxAttempts, err: err?.message },
        "Final retry attempt exhausted - marking email permanently FAILED",
      );
    } else {
      logger.warn(
        { scheduledEmailId, attemptNumber, maxAttempts, err: err?.message },
        "Send attempt failed - BullMQ will retry, not marking permanently FAILED",
      );
    }

    throw err; // let BullMQ's retry/backoff policy take over
  }
}

async function startWorker() {
  try {
    await verifyProductionInfrastructure();
  } catch (err) {
    if (err instanceof ProductionDependencyError) {
      logger.fatal(
        { dependency: err.dependency, err: err.message },
        "FATAL: a required production dependency is unavailable - refusing to start worker."
      );
    } else {
      logger.fatal({ err }, "FATAL: production readiness check failed - refusing to start worker.");
    }
    process.exit(1);
  }

  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: createRedisConnection(),
    concurrency: env.WORKER_CONCURRENCY, // configurable, safe: no shared mutable state across jobs
  });

  worker.on("completed", (job) =>
    logger.debug({ jobId: job.id }, "Job completed"),
  );
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, "Job failed"),
  );

  logger.info({ concurrency: env.WORKER_CONCURRENCY }, "Email worker started");
}

startWorker();
