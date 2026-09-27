import IORedis from "ioredis";
import { env } from "../config/env";

// BullMQ requires maxRetriesPerRequest: null on the connection it manages.
// We share ONE connection object shape across queue/worker/rate-limiter so
// behavior (retries, reconnects) is consistent everywhere.
export function createRedisConnection() {
  return new IORedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });
}

// A singleton for places that just need to run plain Redis commands
// (rate limiter counters, idempotency locks) rather than BullMQ's own
// internal connections.
export const redis = createRedisConnection();
