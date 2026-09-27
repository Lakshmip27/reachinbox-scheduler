import { prisma } from "../lib/prisma";
import { emailQueue, enqueueEmailJob } from "../queues/emailQueue";
import { logger } from "../config/logger";

/**
 * Why this exists:
 * BullMQ + Redis already persist delayed jobs across a *worker/server*
 * restart on their own (Redis is a separate, durable process) - that's the
 * main persistence mechanism, and normally nothing here needs to do anything.
 *
 * This function is a defensive second layer for the edge case where Redis
 * itself was wiped/rebuilt (e.g. `docker compose down -v`) while Postgres
 * data survived: on boot, we look for any ScheduledEmail rows that are
 * still logically pending (SCHEDULED/PENDING/RATE_LIMITED_REQUEUED) but
 * whose bullJobId no longer has a matching job in the queue, and re-enqueue
 * them. Because enqueueEmailJob always uses the row's own id as the BullMQ
 * jobId, this is naturally idempotent - if the job already exists, BullMQ's
 * add() just returns it rather than creating a duplicate.
 *
 * PROCESSING rows are handled separately and more conservatively (see
 * `sweepStaleProcessingRows` below) because blindly re-enqueueing a
 * PROCESSING row risks an actual duplicate send if the crash happened after
 * the SMTP call succeeded - see the Delivery Semantics note in
 * emailWorker.ts.
 */
export async function recoverUnfinishedJobs() {
  const pending = await prisma.scheduledEmail.findMany({
    where: { status: { in: ["PENDING", "SCHEDULED", "RATE_LIMITED_REQUEUED"] } },
  });

  let recovered = 0;
  for (const row of pending) {
    const existingJob = row.bullJobId ? await emailQueue.getJob(row.bullJobId) : null;
    if (existingJob) continue; // still tracked in Redis, nothing to do

    // Never move a scheduledAt that's already in the past further into the
    // future - run it immediately (delay 0) instead so nothing silently
    // slips by an extra hour because the process happened to be down.
    const runAt = row.scheduledAt.getTime() < Date.now() ? new Date() : row.scheduledAt;

    await enqueueEmailJob(
      {
        scheduledEmailId: row.id,
        senderId: row.senderId,
        recipient: row.recipient,
        subject: row.subject,
        bodyHtml: row.bodyHtml,
      },
      runAt,
      { jobId: row.id }
    );

    await prisma.scheduledEmail.update({
      where: { id: row.id },
      data: { bullJobId: row.id, status: "SCHEDULED" },
    });
    recovered++;
  }

  if (recovered > 0) {
    logger.warn({ recovered }, "Recovered scheduled emails missing their Redis job on boot");
  } else {
    logger.info("Recovery check: all pending emails already have live BullMQ jobs");
  }

  await sweepStaleProcessingRows();
}

const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Finds ScheduledEmail rows stuck in PROCESSING with no live BullMQ job
 * behind them - i.e. a worker died mid-send and nothing will ever pick the
 * job back up. Rather than silently leaving these invisible (the bug a
 * naive implementation would have) or blindly re-sending them (which could
 * duplicate an email that actually went out - see Delivery Semantics note),
 * this makes the ambiguity explicit and actionable:
 *
 *   - A SendLedger row exists  -> the SMTP call may have already succeeded.
 *     We cannot safely auto-resend. Mark FAILED with a lastError explaining
 *     the ambiguity, so it surfaces in the Sent/Failed table for a human to
 *     check the Ethereal/provider logs and decide.
 *   - No SendLedger row        -> the crash happened before we ever
 *     attempted to send. Safe to reset to SCHEDULED and re-enqueue.
 */
export async function sweepStaleProcessingRows() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);
  const stale = await prisma.scheduledEmail.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
  });

  let flaggedAmbiguous = 0;
  let resent = 0;

  for (const row of stale) {
    const liveJob = row.bullJobId ? await emailQueue.getJob(row.bullJobId) : null;
    if (liveJob) continue; // a retry is already in flight, leave it alone

    const ledgerEntry = await prisma.sendLedger.findUnique({
      where: { scheduledEmailId: row.id },
    });

    if (ledgerEntry) {
      await prisma.scheduledEmail.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          lastError:
            "Worker crashed mid-send after claiming the send lock. The email may have actually been delivered - verify manually (check Ethereal/provider logs) before assuming it was not sent. Not auto-resent to avoid a possible duplicate.",
        },
      });
      flaggedAmbiguous++;
    } else {
      await enqueueEmailJob(
        {
          scheduledEmailId: row.id,
          senderId: row.senderId,
          recipient: row.recipient,
          subject: row.subject,
          bodyHtml: row.bodyHtml,
        },
        new Date(),
        { jobId: row.id }
      );
      await prisma.scheduledEmail.update({
        where: { id: row.id },
        data: { bullJobId: row.id, status: "SCHEDULED" },
      });
      resent++;
    }
  }

  if (flaggedAmbiguous > 0 || resent > 0) {
    logger.warn(
      { flaggedAmbiguous, resent },
      "Swept stale PROCESSING rows: flagged ambiguous sends for manual review, safely re-enqueued the rest"
    );
  }
}
