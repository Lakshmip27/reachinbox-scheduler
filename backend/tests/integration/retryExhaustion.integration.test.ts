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

describe("Integration: retry exhaustion (real BullMQ + real Postgres)", () => {
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
    "exhausts BullMQ's configured attempts when every send fails, ends PostgreSQL status FAILED with lastError set, and never leaves a SendLedger entry behind",
    async () => {
      const row = await createScheduledEmail(fixtures);
      const jobData = toJobData(row);
      const maxAttempts = 3;

      sendEmailMock.mockRejectedValue(new Error("mailbox permanently unavailable"));

      const finalFailureSeen = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("job did not exhaust retries within the test timeout")),
          15000,
        );

        worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
          connection: createRedisConnection(),
          concurrency: 1,
        });

        worker.on("failed", (job) => {
          if (!job || job.id !== row.id) return;
          const configuredAttempts = job.opts.attempts ?? 1;
          if (job.attemptsMade >= configuredAttempts) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      await emailQueue.add("send-email", jobData, {
        jobId: row.id,
        attempts: maxAttempts,
        backoff: { type: "exponential", delay: 100 },
      });

      await finalFailureSeen;

      // Give the worker's own DB/ledger writes for this last attempt a beat
      // to land - "failed" fires after processEmailJob's own awaits resolve,
      // but we still poll briefly rather than assume perfect ordering.
      let finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      for (let i = 0; i < 10 && finalRow?.status !== "FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      }

      // --- BullMQ exhausted the configured attempts ---
      expect(sendEmailMock).toHaveBeenCalledTimes(maxAttempts);

      // --- final PostgreSQL status is FAILED, with lastError populated ---
      expect(finalRow?.status).toBe("FAILED");
      expect(finalRow?.lastError).toContain("mailbox permanently unavailable");

      // --- no duplicate (or leftover) SendLedger entries ---
      const ledgerRows = await prisma.sendLedger.findMany({ where: { scheduledEmailId: row.id } });
      expect(ledgerRows).toHaveLength(0);
    },
    20000,
  );
});
