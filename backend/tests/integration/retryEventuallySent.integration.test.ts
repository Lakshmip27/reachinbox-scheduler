import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { Worker } from "bullmq";

// Only the genuinely-external services are mocked: outbound SMTP, ES
// indexing (has its own dedicated isolation coverage in
// productionReadiness.test.ts) and Slack. Prisma, Redis, and BullMQ itself
// are all real for this file - that's the point of this test.
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
import { emailQueue, EMAIL_QUEUE_NAME, EmailJobData } from "../../src/queues/emailQueue";
import { processEmailJob } from "../../src/workers/emailWorker";
import {
  createFixtures,
  createScheduledEmail,
  cleanupFixtures,
  toJobData,
  flushRateLimitKeysFor,
  Fixtures,
} from "./helpers";

describe("Integration: retry eventually sent (real BullMQ + real Postgres)", () => {
  let fixtures: Fixtures;
  let worker: Worker<EmailJobData> | undefined;

  beforeAll(async () => {
    fixtures = await createFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
    await flushRateLimitKeysFor(fixtures.senderId);
    await emailQueue.close();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    sendEmailMock.mockReset();
  });

  it(
    "retries a transient SMTP failure through BullMQ's exponential backoff, keeps the row un-FAILED in between, and ends SENT with exactly one SendLedger row",
    async () => {
      const row = await createScheduledEmail(fixtures);
      const jobData = toJobData(row);

      const callTimestamps: number[] = [];
      sendEmailMock.mockImplementation(async () => {
        callTimestamps.push(Date.now());
        if (callTimestamps.length === 1) {
          throw new Error("SMTP timeout - transient, first attempt only");
        }
        return { previewUrl: "https://ethereal.email/preview/retry-success" };
      });

      const backoffDelayMs = 200;
      let statusObservedAfterFirstFailure: string | undefined;
      const failureChecks: Promise<void>[] = [];

      const completed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("job did not complete within the test timeout")),
          15000,
        );

        worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
          connection: createRedisConnection(),
          concurrency: 1,
        });

        // BullMQ emits "failed" on every failed attempt, not just the last
        // one - this is exactly where we can observe the DB state BullMQ
        // has queued a retry but not yet exhausted it.
        worker.on("failed", (job) => {
          if (!job || job.id !== row.id) return;
          failureChecks.push(
            prisma.scheduledEmail.findUnique({ where: { id: row.id } }).then((current) => {
              statusObservedAfterFirstFailure = current?.status;
            }),
          );
        });

        worker.on("completed", (job) => {
          if (job.id !== row.id) return;
          clearTimeout(timeout);
          resolve();
        });
      });

      await emailQueue.add("send-email", jobData, {
        jobId: row.id,
        attempts: 3,
        backoff: { type: "exponential", delay: backoffDelayMs },
      });

      await completed;
      await Promise.all(failureChecks);

      // --- BullMQ retry occurred ---
      expect(callTimestamps).toHaveLength(2);

      // --- exponential backoff configuration was respected (retry was
      // genuinely delayed, not fired back-to-back) ---
      const gapMs = callTimestamps[1] - callTimestamps[0];
      expect(gapMs).toBeGreaterThanOrEqual(backoffDelayMs * 0.75);

      // --- DB did not become permanently FAILED after the first failure ---
      expect(statusObservedAfterFirstFailure).toBe("SCHEDULED");

      // --- final status is SENT ---
      const finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(finalRow?.status).toBe("SENT");
      expect(finalRow?.sentAt).toBeInstanceOf(Date);
      expect(finalRow?.lastError).toContain("SMTP timeout");

      // --- SendLedger contains exactly the one correct entry ---
      const ledgerRows = await prisma.sendLedger.findMany({ where: { scheduledEmailId: row.id } });
      expect(ledgerRows).toHaveLength(1);
    },
    20000,
  );
});
