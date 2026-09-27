import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

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
import { processEmailJob } from "../../src/workers/emailWorker";
import {
  createFixtures,
  createScheduledEmail,
  cleanupFixtures,
  toJobData,
  makeFakeJob,
  flushRateLimitKeysFor,
  Fixtures,
} from "./helpers";

// This is the scenario SendLedger's unique constraint exists for: two
// workers (or one worker processing a job it thinks stalled, plus the
// original still-running attempt) both start processing the exact same
// ScheduledEmail concurrently. Deliberately calls processEmailJob directly
// (rather than going through BullMQ, whose own jobId de-dup would prevent
// this specific race from happening via the queue) so the DB-level guard
// gets exercised on its own, against a real Postgres instance.
describe("Integration: idempotency under concurrent processing (real Postgres unique constraint)", () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await createFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures(fixtures);
    await flushRateLimitKeysFor(fixtures.senderId);
    await prisma.$disconnect();
  });

  afterEach(() => {
    sendEmailMock.mockReset();
  });

  it(
    "lets only one of two concurrent processEmailJob calls for the same row actually send, the other exits safely without throwing",
    async () => {
      const row = await createScheduledEmail(fixtures);
      const jobData = toJobData(row);

      let sendCount = 0;
      sendEmailMock.mockImplementation(async () => {
        sendCount++;
        // A small delay widens the race window between the two concurrent
        // calls, making it far more likely both reach sendLedger.create()
        // before either finishes - the real-world crash-recovery scenario
        // this guard protects against.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { previewUrl: "https://ethereal.email/preview/idempotent" };
      });

      const results = await Promise.allSettled([
        processEmailJob(makeFakeJob(jobData)),
        processEmailJob(makeFakeJob(jobData)),
      ]);

      // --- duplicate processing exits safely (neither call throws) ---
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      // --- only one actual SMTP send occurred ---
      expect(sendCount).toBe(1);

      // --- PostgreSQL's unique constraint on SendLedger prevented the
      // second claim: exactly one row for this email, ever ---
      const ledgerRows = await prisma.sendLedger.findMany({ where: { scheduledEmailId: row.id } });
      expect(ledgerRows).toHaveLength(1);

      const finalRow = await prisma.scheduledEmail.findUnique({ where: { id: row.id } });
      expect(finalRow?.status).toBe("SENT");
    },
    15000,
  );
});
