import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock every external dependency processEmailJob touches, so this test
// never needs a real Redis/BullMQ/Postgres/SMTP connection. ---

const findUniqueMock = vi.fn();
const updateScheduledEmailMock = vi.fn();
const sendLedgerCreateMock = vi.fn();
const sendLedgerDeleteMock = vi.fn();

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    scheduledEmail: {
      findUnique: (...args: any[]) => findUniqueMock(...args),
      update: (...args: any[]) => updateScheduledEmailMock(...args),
    },
    sendLedger: {
      create: (...args: any[]) => sendLedgerCreateMock(...args),
      delete: (...args: any[]) => sendLedgerDeleteMock(...args),
    },
  },
}));

const checkAndConsumeHourlySlotMock = vi.fn();
const reserveSendSlotMock = vi.fn();
vi.mock("../src/services/rateLimiter", () => ({
  checkAndConsumeHourlySlot: (...args: any[]) => checkAndConsumeHourlySlotMock(...args),
  reserveSendSlot: (...args: any[]) => reserveSendSlotMock(...args),
}));

const sendEmailMock = vi.fn();
vi.mock("../src/services/mailer", () => ({
  sendEmail: (...args: any[]) => sendEmailMock(...args),
}));

const indexEmailMock = vi.fn();
vi.mock("../src/services/searchIndex", () => ({
  indexEmail: (...args: any[]) => indexEmailMock(...args),
}));

const notifyRateLimitHitMock = vi.fn();
vi.mock("../src/services/slack", () => ({
  notifyRateLimitHit: (...args: any[]) => notifyRateLimitHitMock(...args),
}));

vi.mock("../src/config/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// emailWorker.ts also does `new Worker(...)` and `createRedisConnection()`
// at module scope - stub both out so importing the module never opens a
// real connection or starts a real BullMQ worker loop.
vi.mock("../src/lib/redis", () => ({
  createRedisConnection: () => ({}),
  redis: {},
}));

vi.mock("bullmq", () => {
  class FakeDelayedError extends Error {}
  return {
    Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
    Queue: vi.fn().mockImplementation(() => ({})),
    DelayedError: FakeDelayedError,
  };
});

import { processEmailJob } from "../src/workers/emailWorker";

const scheduledEmailId = "email-1";
const senderId = "sender-1";
const campaignId = "campaign-1";

const emailRowFixture = {
  id: scheduledEmailId,
  campaignId,
  senderId,
  userId: "user-1",
  recipient: "alice@example.com",
  subject: "Hello",
  bodyHtml: "<p>hi</p>",
  status: "SCHEDULED",
  scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
  sender: {
    id: senderId,
    label: "Sender A",
    smtpHost: "smtp.ethereal.email",
    smtpPort: 587,
    smtpUser: "smtp-user",
    smtpPass: "smtp-pass",
    maxEmailsPerHour: 10,
  },
  campaign: {
    userId: "user-1",
    delayMs: 0,
    hourlyLimit: 10,
  },
};

function makeJob(attemptsMade: number, attempts = 5) {
  return {
    data: {
      scheduledEmailId,
      senderId,
      recipient: emailRowFixture.recipient,
      subject: emailRowFixture.subject,
      bodyHtml: emailRowFixture.bodyHtml,
    },
    attemptsMade,
    opts: { attempts },
    moveToDelayed: vi.fn(),
  } as any;
}

describe("processEmailJob - retry status handling", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateScheduledEmailMock.mockReset();
    sendLedgerCreateMock.mockReset();
    sendLedgerDeleteMock.mockReset();
    checkAndConsumeHourlySlotMock.mockReset();
    reserveSendSlotMock.mockReset();
    sendEmailMock.mockReset();
    indexEmailMock.mockReset();
    notifyRateLimitHitMock.mockReset();

    findUniqueMock.mockResolvedValue(emailRowFixture);
    updateScheduledEmailMock.mockResolvedValue({});
    sendLedgerCreateMock.mockResolvedValue({});
    sendLedgerDeleteMock.mockResolvedValue({});
    indexEmailMock.mockResolvedValue(undefined);
    notifyRateLimitHitMock.mockResolvedValue(undefined);

    // Never rate-limited in these tests - we're testing the send/retry path.
    checkAndConsumeHourlySlotMock.mockResolvedValue({ allowed: true });
    reserveSendSlotMock.mockResolvedValue(Date.now());
  });

  it("initial failure -> retry -> eventual success: does not leave the row FAILED, and ends at SENT", async () => {
    // --- Attempt 1 of 5 fails (a transient SMTP error). ---
    sendEmailMock.mockRejectedValueOnce(new Error("SMTP timeout"));
    const job1 = makeJob(/* attemptsMade */ 0, /* attempts */ 5);

    await expect(processEmailJob(job1)).rejects.toThrow("SMTP timeout");

    // Must NOT be marked FAILED - BullMQ still has 4 attempts left.
    const firstUpdateCall = updateScheduledEmailMock.mock.calls.find(
      (call) => call[0]?.data?.status && call[0].data.status !== "PROCESSING"
    );
    expect(firstUpdateCall?.[0].data.status).toBe("SCHEDULED");
    expect(firstUpdateCall?.[0].data.status).not.toBe("FAILED");
    expect(firstUpdateCall?.[0].data.attempts).toEqual({ increment: 1 });
    expect(firstUpdateCall?.[0].data.lastError).toContain("SMTP timeout");

    // --- BullMQ retries: attempt 2 of 5, this time it succeeds. ---
    updateScheduledEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ previewUrl: "https://ethereal.email/preview/2" });
    const job2 = makeJob(/* attemptsMade */ 1, /* attempts */ 5);

    await expect(processEmailJob(job2)).resolves.toBeUndefined();

    const sentUpdateCall = updateScheduledEmailMock.mock.calls.find(
      (call) => call[0]?.data?.status === "SENT"
    );
    expect(sentUpdateCall).toBeDefined();
    expect(sentUpdateCall?.[0].data.sentAt).toBeInstanceOf(Date);

    // Final DB state is SENT, never FAILED, across the whole retry sequence.
    const anyFailedWrite = updateScheduledEmailMock.mock.calls.some(
      (call) => call[0]?.data?.status === "FAILED"
    );
    expect(anyFailedWrite).toBe(false);
  });

  it("an intermediate failure (not yet the last attempt) keeps status SCHEDULED, not FAILED", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("connection reset"));
    // attemptsMade=1 means this is attempt #2 of 5 - three attempts remain.
    const job = makeJob(1, 5);

    await expect(processEmailJob(job)).rejects.toThrow("connection reset");

    const statusUpdate = updateScheduledEmailMock.mock.calls.find(
      (call) => call[0]?.data?.status && call[0].data.status !== "PROCESSING"
    );
    expect(statusUpdate?.[0].data.status).toBe("SCHEDULED");

    const indexCall = indexEmailMock.mock.calls.find((call) => call[0]?.status !== "PROCESSING");
    expect(indexCall?.[0].status).toBe("SCHEDULED");
  });

  it("marks the email FAILED only once the final configured attempt is exhausted", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("mailbox unavailable"));
    // attemptsMade=4 with attempts=5 means this IS the 5th and final attempt.
    const job = makeJob(4, 5);

    await expect(processEmailJob(job)).rejects.toThrow("mailbox unavailable");

    const statusUpdate = updateScheduledEmailMock.mock.calls.find(
      (call) => call[0]?.data?.status && call[0].data.status !== "PROCESSING"
    );
    expect(statusUpdate?.[0].data.status).toBe("FAILED");
    expect(statusUpdate?.[0].data.lastError).toContain("mailbox unavailable");

    const indexCall = indexEmailMock.mock.calls.find((call) => call[0]?.status !== "PROCESSING");
    expect(indexCall?.[0].status).toBe("FAILED");
  });

  it("still throws the original error on the final attempt so BullMQ records the job as failed", async () => {
    const err = new Error("permanent SMTP rejection");
    sendEmailMock.mockRejectedValueOnce(err);
    const job = makeJob(4, 5);

    await expect(processEmailJob(job)).rejects.toBe(err);
  });
});
