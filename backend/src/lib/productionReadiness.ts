import IORedis from "ioredis";
import { prisma } from "./prisma";
import { esClient } from "../services/searchIndex";
import { env } from "../config/env";
import { logger } from "../config/logger";

const CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Thrown when a HARD production requirement (PostgreSQL, Redis) is
 * unreachable at boot. Callers (server.ts, emailWorker.ts) are expected to
 * log this and process.exit(1) - the error itself never calls
 * process.exit so verifyProductionInfrastructure() stays unit-testable as
 * a plain rejecting promise.
 */
export class ProductionDependencyError extends Error {
  constructor(
    public readonly dependency: "postgres" | "redis",
    message: string
  ) {
    super(message);
    this.name = "ProductionDependencyError";
  }
}

async function checkPostgres(): Promise<void> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS, "PostgreSQL");
  } catch (err) {
    throw new ProductionDependencyError(
      "postgres",
      `PostgreSQL is required in production and is unreachable via DATABASE_URL. Refusing to start. Original error: ${(err as Error).message}`
    );
  }
}

async function checkRedis(): Promise<void> {
  // A separate, short-lived, non-retrying connection - deliberately NOT the
  // shared `redis` singleton from lib/redis.ts (which uses
  // `maxRetriesPerRequest: null` and retries forever, as BullMQ requires
  // for its own long-lived connections). That's correct once the app is
  // running, but wrong for a boot-time check, which must fail fast rather
  // than hang indefinitely waiting for a Redis that may never come up.
  const probe = new IORedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    connectTimeout: CHECK_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await withTimeout(probe.connect(), CHECK_TIMEOUT_MS, "Redis connection");
    await withTimeout(probe.ping(), CHECK_TIMEOUT_MS, "Redis PING");
  } catch (err) {
    throw new ProductionDependencyError(
      "redis",
      `Redis is required in production and is unreachable (REDIS_HOST=${env.REDIS_HOST}, REDIS_PORT=${env.REDIS_PORT}). ` +
        `This app has no in-memory queue fallback - refusing to start rather than silently running without a durable job queue. ` +
        `Original error: ${(err as Error).message}`
    );
  } finally {
    probe.disconnect();
  }
}

async function checkElasticsearch(): Promise<void> {
  try {
    await withTimeout(esClient.ping(), CHECK_TIMEOUT_MS, "Elasticsearch");
    logger.info("Elasticsearch reachable");
  } catch (err) {
    // Elasticsearch backs search only - scheduling and sending don't
    // depend on it, so (unlike Postgres/Redis) we log loudly and keep
    // going rather than refusing to start. Matches the existing
    // ensureEmailIndex().catch(...) handling already in server.ts.
    logger.error(
      { err: (err as Error).message, node: env.ELASTICSEARCH_NODE },
      "Elasticsearch is unreachable in production - search endpoints will be degraded until it recovers. Continuing startup: Postgres and Redis are the only hard requirements."
    );
  }
}

/**
 * Verifies production's hard infrastructure requirements are actually
 * reachable (not just configured) - PostgreSQL and Redis - and checks, but
 * does not hard-require, Elasticsearch.
 *
 * A no-op outside production: dev/test behavior is completely unchanged,
 * matching how env.ts already validates shape but not live connectivity
 * for those environments.
 *
 * Throws ProductionDependencyError for a missing hard requirement. Does
 * not call process.exit itself - see server.ts / emailWorker.ts for the
 * boundary where that happens, keeping this function a plain testable
 * async function.
 */
export async function verifyProductionInfrastructure(): Promise<void> {
  if (env.NODE_ENV !== "production") return;

  await checkPostgres();
  await checkRedis();
  await checkElasticsearch(); // never throws - see comment above
}
