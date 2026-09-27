import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { Worker } from "bullmq";

const sendEmailMock = vi.fn();
vi.mock("../../src/services/mailer", () => ({
  sendEmail: (...args: any[]) => sendEmailMock(...args),
}));
vi.mock("../../src/services/searchIndex", () => ({
  indexEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/slack", () => ({
  notifyRateLimitHit: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../src/lib/prisma";
import { createRedisConnection } from "../../src/lib/redis";
import { emailQueue, enqueueEmailJob, EMAIL_QUEUE_NAME, EmailJobData } from "../../src/queues/emailQueue";
import { processEmailJob } from "../../src/workers/emailWorker";
import { recoverUnfinishedJobs, sweepStaleProcessingRows } from "../../src/services/recovery";
import {
  createFixtures,
  createScheduledEmail,
  cleanupFixtures,
  toJobData,
  flushRateLimitKeysFor,
  Fixtures,
} from "./helpers";

/** Runs the real worker against the real queue until the given job id
 * completes, so each recovery scenario can also assert on the *final*
 * delivered state, not just the recovery bookkeeping. */
async function runJobToCompletion(scheduledEmailId: string, timeoutMs = 15000) {
  let worker: Worker<EmailJobData> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("recovered job did not complete within the test timeout")),
        timeoutMs,
      );
      worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
        connection: createRedisConnection(),
        concurrency: 1,
      });
      worker.on("completed", (job) => {
        if (job.id !== scheduledEmailId) return;
        clearTimeout(timeout);
        resolve();
      });
      worker.on("failed", (job, err) => {
        if (job?.id !== scheduledEmailId) return;
        clearTimeout(timeout);
        reject(err);
      });
    });
  } finally {
    await worker?.close();
  }
}

// Ages a row past sweepStaleProcessingRows' 10-minute staleness threshold.
// Prisma's @updatedAt is normally auto-managed on every write, so backdating
// it requires a raw SQL statement rather than a normal `update()` call.
async function backdateUpdatedAt(scheduledEmailId: string, minutesAgo: number) {
  await prisma.$executeRaw`
    UPDATE "ScheduledEmail"
    SET "updatedAt" = NOW() - make_interval(mins => ${minutesAgo})
    WHERE id = ${scheduledEmailId}
  `;
}

describe("Integration: restart/recovery (real BullMQ + real Postgres)", () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await createFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
    await flushRateLimitKeysFor(fixtures.senderId);
    await emailQueue.close();
    await prisma.$disconnect();
  });

  afterEach(() => {
    sendEmailMock.mockReset();
  });

  it(
    "re-enqueues a SCHEDULED job whose BullMQ job was lost (simulated Redis/restart data loss) without duplicating it, and it still completes correctly",
    async () => {
      const row = await createScheduledEmail(fixtures, {
        status: "SCHEDULED",
        // In the past, so recovery schedules it to run immediately rather
        // than waiting out its original delay.
        scheduledAt: new Date(Date.now() - 1000),
      });

      await enqueueEmailJob(toJobData(row), new Date(Date.now() + 60000), { jobId: row.id });
      await prisma.scheduledEmail.update({ where: { id: row.id }, data: { bullJobId: row.id } });

      const originalJob = await emailQueue.getJob(row.id);
      expect(originalJob).toBeTruthy();

      // Simulate the backend/worker restarting with Redis's job data lost
      // (e.g. `docker compose down -v`) while Postgres survived.
      await originalJob!.remove();
      expect(await emailQueue.getJob(row.id)).toBeUndefined();

      // First boot after the "restart": the job must become recoverable again.
      await recoverUnfinishedJobs();
      const recoveredJob = await emailQueue.getJob(row.id);
      expect(recoveredJob).toBeTruthy();

      // A second recovery pass (e.g. a flapping process rebooting twice)
      // must not create a second job for the same row.
      await recoverUnfinishedJobs();
      const jobsForRow = (await emailQueue.getJobs(["waiting", "delayed", "active"] as any)).filter(
        (j) => j.id === row.id,
      );
      expect(jobsForRow).toHaveLength(1);

      const rowAfterRecovery = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(rowAfterRecovery?.status).toBe("SCHEDULED");

      // Final state is correct: the recovered job actually delivers.
      sendEmailMock.mockResolvedValueOnce({ previewUrl: "https://ethereal.email/preview/recovered" });
      await runJobToCompletion(row.id);

      const finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(finalRow?.status).toBe("SENT");
    },
    30000,
  );

  it(
    "safely re-enqueues a stale PROCESSING row with no SendLedger claim (worker crashed before ever attempting to send), and it completes correctly",
    async () => {
      const row = await createScheduledEmail(fixtures, { status: "PROCESSING" });
      await backdateUpdatedAt(row.id, 15);

      await sweepStaleProcessingRows();

      const recoveredRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(recoveredRow?.status).toBe("SCHEDULED");
      expect(recoveredRow?.bullJobId).toBe(row.id);

      const job = await emailQueue.getJob(row.id);
      expect(job).toBeTruthy();

      sendEmailMock.mockResolvedValueOnce({ previewUrl: "https://ethereal.email/preview/swept" });
      await runJobToCompletion(row.id);

      const finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(finalRow?.status).toBe("SENT");
    },
    30000,
  );

  it(
    "does NOT resend a stale PROCESSING row that already has a SendLedger claim (ambiguous crash mid-send) - marks it FAILED instead, with no re-enqueue and no new send",
    async () => {
      const row = await createScheduledEmail(fixtures, { status: "PROCESSING" });
      await prisma.sendLedger.create({ data: { scheduledEmailId: row.id } });
      await backdateUpdatedAt(row.id, 15);

      await sweepStaleProcessingRows();

      const finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(finalRow?.status).toBe("FAILED");
      expect(finalRow?.lastError).toContain("Worker crashed mid-send");

      // Never re-enqueued - a duplicate send would be possible here.
      expect(await emailQueue.getJob(row.id)).toBeFalsy();
      expect(sendEmailMock).not.toHaveBeenCalled();

      // The original ledger claim is left exactly as it was - not duplicated.
      const ledgerRows = await prisma.sendLedger.findMany({ where: { scheduledEmailId: row.id } });
      expect(ledgerRows).toHaveLength(1);
    },
    15000,
  );
});
