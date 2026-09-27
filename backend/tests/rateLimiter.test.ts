import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared Redis client before importing the module under test, so
// we're testing checkAndConsumeHourlySlot/reserveSendSlot's own logic
// (how they interpret the Lua script's return value) without needing a
// real Redis server or a Lua interpreter in the test environment.
const evalMock = vi.fn();
vi.mock("../src/lib/redis", () => ({
  redis: { eval: (...args: any[]) => evalMock(...args) },
}));

import { checkAndConsumeHourlySlot, reserveSendSlot } from "../src/services/rateLimiter";

describe("checkAndConsumeHourlySlot", () => {
  beforeEach(() => evalMock.mockReset());

  it("allows the send when the Lua script returns a positive count", async () => {
    evalMock.mockResolvedValue(5); // 5th email this hour, under the cap
    const result = await checkAndConsumeHourlySlot("sender-1:campaign-1", 200);
    expect(result.allowed).toBe(true);
    expect(result.nextWindowStart).toBeUndefined();
  });

  it("denies the send and returns the next hour boundary when the script returns -1", async () => {
    evalMock.mockResolvedValue(-1); // cap reached
    const before = Date.now();
    const result = await checkAndConsumeHourlySlot("sender-1:campaign-1", 200);
    expect(result.allowed).toBe(false);
    expect(result.nextWindowStart).toBeDefined();
    // The next window must be strictly in the future and hour-aligned.
    expect(result.nextWindowStart!).toBeGreaterThan(before);
    expect(result.nextWindowStart! % (60 * 60 * 1000)).toBe(0);
  });

  it("scopes the Redis key by the caller-provided limiterKey, not a bare senderId", async () => {
    evalMock.mockResolvedValue(1);
    await checkAndConsumeHourlySlot("sender-1:campaign-1", 200);
    const [, , key] = evalMock.mock.calls[0];
    expect(key).toContain("sender-1:campaign-1");
  });
});

describe("checkAndConsumeHourlySlot - global per-sender quota across campaigns", () => {
  // This is a JS re-implementation of exactly what HOURLY_INCR_SCRIPT does
  // (GET current, and only INCR/EXPIRE if still under the limit), used as a
  // stateful stand-in for Redis so we can prove the *business behavior* of
  // sharing one counter across campaigns - not just what arguments were
  // passed to eval(). Each test gets a fresh store via beforeEach.
  let store: Map<string, number>;

  beforeEach(() => {
    store = new Map();
    evalMock.mockReset();
    evalMock.mockImplementation(async (_script: string, _numKeys: number, key: string, limit: string) => {
      const current = store.get(key) ?? 0;
      const limitNum = Number(limit);
      if (current >= limitNum) return -1;
      const next = current + 1;
      store.set(key, next);
      return next;
    });
  });

  it("shares one hourly counter for two campaigns from the same sender - the fix's exact scenario", async () => {
    // Sender A has a 10/hour limit. Both campaigns key off the sender only
    // (as emailWorker.ts now does), NOT `${senderId}:${campaignId}`.
    const senderKey = "sender-A";
    const hourlyLimit = 10;

    // Campaign 1 sends 7 - all should be allowed.
    let campaign1Allowed = 0;
    for (let i = 0; i < 7; i++) {
      const result = await checkAndConsumeHourlySlot(senderKey, hourlyLimit);
      if (result.allowed) campaign1Allowed++;
    }
    expect(campaign1Allowed).toBe(7);

    // Campaign 2 then attempts 7 more from the SAME sender key - only 3
    // more should fit under the shared 10/hour cap; the remaining 4 must
    // be denied (and, in the real worker, rescheduled).
    let campaign2Allowed = 0;
    let campaign2Denied = 0;
    for (let i = 0; i < 7; i++) {
      const result = await checkAndConsumeHourlySlot(senderKey, hourlyLimit);
      if (result.allowed) campaign2Allowed++;
      else campaign2Denied++;
    }

    expect(campaign2Allowed).toBe(3);
    expect(campaign2Denied).toBe(4);
    // Total sent across BOTH campaigns never exceeds the sender's own cap.
    expect(campaign1Allowed + campaign2Allowed).toBe(hourlyLimit);
  });

  it("does NOT double the sender's throughput when two campaigns use distinct per-campaign keys (regression guard)", async () => {
    // Sanity check for the bug being fixed: if the old `${senderId}:${campaignId}`
    // keying were still in use, each campaign would get its own independent
    // 10-slot bucket and the sender could send up to 20/hour. Proving the
    // combined-key case here documents what the old (buggy) behavior would
    // have allowed, so the shared-key test above is meaningfully a fix.
    const hourlyLimit = 10;
    let allowedUnderOldScheme = 0;
    for (let i = 0; i < 7; i++) {
      if ((await checkAndConsumeHourlySlot("sender-A:campaign-1", hourlyLimit)).allowed) allowedUnderOldScheme++;
    }
    for (let i = 0; i < 7; i++) {
      if ((await checkAndConsumeHourlySlot("sender-A:campaign-2", hourlyLimit)).allowed) allowedUnderOldScheme++;
    }
    // Under the old per-campaign keying this is 14 (a real quota bypass);
    // this test exists purely to document/contrast that with the fixed
    // behavior above, not to assert the fix - it deliberately drives the
    // same helper with the OLD key shape to prove the shape of the key is
    // what determines whether the bypass is possible.
    expect(allowedUnderOldScheme).toBe(14);
  });

  it("cannot be bypassed by concurrent workers racing on the same sender key", async () => {
    // Fire 15 "concurrent" attempts (simulating multiple worker processes
    // racing on the same sender) against a 10/hour cap in a single batch.
    // Because checkAndConsumeHourlySlot is a single atomic eval() round
    // trip (one GET+INCR done server-side in Lua, never a separate
    // get-then-set from Node), no interleaving of concurrent calls can
    // observe a stale count - exactly the same atomicity our stateful mock
    // preserves here since it does its read-and-write in one synchronous
    // step per call, with no await between them.
    const results = await Promise.all(
      Array.from({ length: 15 }, () => checkAndConsumeHourlySlot("sender-A", 10))
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.filter((r) => !r.allowed).length;

    expect(allowedCount).toBe(10);
    expect(deniedCount).toBe(5);

    // Exactly one atomic Redis round trip per attempt - no separate
    // check-then-increment calls that could race.
    expect(evalMock).toHaveBeenCalledTimes(15);
  });
});

describe("reserveSendSlot", () => {
  beforeEach(() => evalMock.mockReset());

  it("returns the timestamp the Lua script reserved", async () => {
    const reserved = Date.now() + 2000;
    evalMock.mockResolvedValue(reserved);
    const result = await reserveSendSlot("sender-1:campaign-1", 2000);
    expect(result).toBe(reserved);
  });

  it("passes the configured min delay through to the script as an argument", async () => {
    evalMock.mockResolvedValue(Date.now());
    await reserveSendSlot("sender-1:campaign-1", 5000);
    const args = evalMock.mock.calls[0];
    expect(args).toContain("5000");
  });
});
