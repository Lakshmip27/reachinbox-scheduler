import { redis } from "../lib/redis";

/**
 * Rate limiting design
 * ---------------------
 * Two independent controls, both enforced with atomic Redis Lua scripts so
 * they are safe across multiple worker processes/instances (never relying on
 * in-memory counters):
 *
 * 1. HOURLY CAP, scoped GLOBALLY per sender: key `rl:hour:{limiterKey}:{hourBucket}`,
 *    where the caller (emailWorker.ts) passes `limiterKey = senderId` (no
 *    campaignId). This is deliberate: a sender's real hourly SMTP throughput
 *    limit belongs to the sender/mailbox, not to any one campaign, so every
 *    campaign sending from the same Sender shares one counter. Two campaigns
 *    from the same sender can no longer each independently exhaust a full
 *    hourly quota and together double the sender's real send rate.
 * 2. MIN DELAY BETWEEN SENDS, scoped per (sender, campaign): key
 *    `rl:nextslot:{limiterKey}`, where the caller passes
 *    `limiterKey = ${senderId}:${campaignId}`. Each campaign's own configured
 *    send cadence stays independent - this is a pacing control, not a quota,
 *    so there's no cross-campaign bypass risk to fix here.
 *
 * `limiterKey` itself is caller-defined and opaque to this module; the two
 * call sites above choose different granularity for their own reasons.
 *
 * Both checks are atomic (Lua `GET`+`INCR` / `GET`+`SET` in a single round
 * trip), so concurrent workers racing on the same key cannot together
 * exceed the configured limit - the increment only proceeds if the counter
 * read in that same script invocation is still under the cap.
 */

const HOUR_MS = 60 * 60 * 1000;

// KEYS[1] = hourly counter key
// ARGV[1] = limit
// ARGV[2] = ttl seconds for the counter key
// returns: current count after increment (only incremented if under/at limit)
//          if over limit, returns -1 and does NOT increment further
const HOURLY_INCR_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if current >= limit then
  return -1
end
local newVal = redis.call('INCR', KEYS[1])
if newVal == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return newVal
`;

// KEYS[1] = next-slot key
// ARGV[1] = min delay ms
// returns the epoch-ms timestamp the caller must wait until before sending
const RESERVE_SLOT_SCRIPT = `
local now = tonumber(ARGV[2])
local minDelay = tonumber(ARGV[1])
local nextSlot = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved
if nextSlot <= now then
  reserved = now
else
  reserved = nextSlot
end
local newNextSlot = reserved + minDelay
redis.call('SET', KEYS[1], newNextSlot, 'PX', minDelay * 10 + 60000)
return reserved
`;

export interface HourlyCheckResult {
  allowed: boolean;
  /** If not allowed, the epoch-ms timestamp of the start of the next hour window. */
  nextWindowStart?: number;
}

/** Atomically check-and-increment the hourly counter for a given limiter key. */
export async function checkAndConsumeHourlySlot(
  limiterKey: string,
  hourlyLimit: number
): Promise<HourlyCheckResult> {
  const now = Date.now();
  const hourBucket = Math.floor(now / HOUR_MS);
  const key = `rl:hour:${limiterKey}:${hourBucket}`;

  const result = await redis.eval(
    HOURLY_INCR_SCRIPT,
    1,
    key,
    hourlyLimit.toString(),
    "7200" // 2 hour TTL safety margin
  );

  if (Number(result) === -1) {
    const nextWindowStart = (hourBucket + 1) * HOUR_MS;
    return { allowed: false, nextWindowStart };
  }
  return { allowed: true };
}

/**
 * Reserve the next available send slot respecting the minimum delay between
 * sends for a given limiter key. Returns the epoch-ms timestamp the worker
 * should (if needed) wait until before actually calling the SMTP transport.
 */
export async function reserveSendSlot(limiterKey: string, minDelayMs: number): Promise<number> {
  const key = `rl:nextslot:${limiterKey}`;
  const now = Date.now();
  const reservedAt = await redis.eval(RESERVE_SLOT_SCRIPT, 1, key, minDelayMs.toString(), now.toString());
  return Number(reservedAt);
}
