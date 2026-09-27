import { describe, it, expect, vi, beforeEach } from "vitest";

const staleRow = {
  id: "email-1",
  bullJobId: "email-1",
  senderId: "sender-1",
  recipient: "alice@example.com",
  subject: "Hi",
  bodyHtml: "<p>hi</p>",
  status: "PROCESSING",
};

const findManyMock = vi.fn();
const findUniqueLedgerMock = vi.fn();
const updateScheduledEmailMock = vi.fn();
const getJobMock = vi.fn();
const enqueueEmailJobMock = vi.fn();

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    scheduledEmail: {
      findMany: (...args: any[]) => findManyMock(...args),
      update: (...args: any[]) => updateScheduledEmailMock(...args),
    },
    sendLedger: {
      findUnique: (...args: any[]) => findUniqueLedgerMock(...args),
    },
  },
}));

vi.mock("../src/queues/emailQueue", () => ({
  emailQueue: { getJob: (...args: any[]) => getJobMock(...args) },
  enqueueEmailJob: (...args: any[]) => enqueueEmailJobMock(...args),
}));

import { sweepStaleProcessingRows } from "../src/services/recovery";

describe("sweepStaleProcessingRows", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findUniqueLedgerMock.mockReset();
    updateScheduledEmailMock.mockReset();
    getJobMock.mockReset();
    enqueueEmailJobMock.mockReset();
  });

  it("skips rows that still have a live BullMQ job (a retry is already in flight)", async () => {
    findManyMock.mockResolvedValue([staleRow]);
    getJobMock.mockResolvedValue({ id: "email-1" }); // job still exists

    await sweepStaleProcessingRows();

    expect(updateScheduledEmailMock).not.toHaveBeenCalled();
    expect(enqueueEmailJobMock).not.toHaveBeenCalled();
  });

  it("flags as FAILED (does NOT resend) when a SendLedger row exists - ambiguous crash", async () => {
    findManyMock.mockResolvedValue([staleRow]);
    getJobMock.mockResolvedValue(null); // no live job
    findUniqueLedgerMock.mockResolvedValue({ id: "ledger-1", scheduledEmailId: "email-1" });

    await sweepStaleProcessingRows();

    expect(enqueueEmailJobMock).not.toHaveBeenCalled(); // must never auto-resend an ambiguous send
    expect(updateScheduledEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "email-1" },
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });

  it("safely re-enqueues when no SendLedger row exists - crash happened before any send attempt", async () => {
    findManyMock.mockResolvedValue([staleRow]);
    getJobMock.mockResolvedValue(null);
    findUniqueLedgerMock.mockResolvedValue(null); // never claimed a send slot

    await sweepStaleProcessingRows();

    expect(enqueueEmailJobMock).toHaveBeenCalledTimes(1);
    expect(updateScheduledEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "email-1" },
        data: expect.objectContaining({ status: "SCHEDULED" }),
      })
    );
  });
});
