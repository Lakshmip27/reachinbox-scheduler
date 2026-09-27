import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEnv: any = vi.hoisted(() => ({
  NODE_ENV: "development",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: 6379,
  REDIS_PASSWORD: undefined,
  ELASTICSEARCH_NODE: "http://localhost:9200",
}));
vi.mock("../src/config/env", () => ({ env: mockEnv }));

vi.mock("../src/config/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const queryRawMock = vi.fn();
vi.mock("../src/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: any[]) => queryRawMock(...args) },
}));

const esPingMock = vi.fn();
vi.mock("../src/services/searchIndex", () => ({
  esClient: { ping: (...args: any[]) => esPingMock(...args) },
}));

const redisConnectMock = vi.fn();
const redisPingMock = vi.fn();
const redisDisconnectMock = vi.fn();
vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    connect: (...args: any[]) => redisConnectMock(...args),
    ping: (...args: any[]) => redisPingMock(...args),
    disconnect: (...args: any[]) => redisDisconnectMock(...args),
  })),
}));

import { verifyProductionInfrastructure, ProductionDependencyError } from "../src/lib/productionReadiness";

describe("verifyProductionInfrastructure", () => {
  beforeEach(() => {
    mockEnv.NODE_ENV = "development";
    queryRawMock.mockReset().mockResolvedValue([{ "?column?": 1 }]);
    esPingMock.mockReset().mockResolvedValue({});
    redisConnectMock.mockReset().mockResolvedValue(undefined);
    redisPingMock.mockReset().mockResolvedValue("PONG");
    redisDisconnectMock.mockReset();
  });

  it("is a no-op outside production (development) - touches no dependency", async () => {
    mockEnv.NODE_ENV = "development";
    await expect(verifyProductionInfrastructure()).resolves.toBeUndefined();
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(redisConnectMock).not.toHaveBeenCalled();
    expect(esPingMock).not.toHaveBeenCalled();
  });

  it("is a no-op outside production (test) - touches no dependency", async () => {
    mockEnv.NODE_ENV = "test";
    await expect(verifyProductionInfrastructure()).resolves.toBeUndefined();
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(redisConnectMock).not.toHaveBeenCalled();
    expect(esPingMock).not.toHaveBeenCalled();
  });

  it("in production, resolves when Postgres, Redis and Elasticsearch are all reachable", async () => {
    mockEnv.NODE_ENV = "production";
    await expect(verifyProductionInfrastructure()).resolves.toBeUndefined();
    expect(queryRawMock).toHaveBeenCalled();
    expect(redisConnectMock).toHaveBeenCalled();
    expect(redisPingMock).toHaveBeenCalled();
    expect(esPingMock).toHaveBeenCalled();
    // The probe connection must always be cleaned up, success or failure.
    expect(redisDisconnectMock).toHaveBeenCalled();
  });

  it("in production, throws ProductionDependencyError('postgres') when Postgres is unreachable - and never claims to be a Redis problem", async () => {
    mockEnv.NODE_ENV = "production";
    queryRawMock.mockRejectedValue(new Error("connection refused"));

    const err = await verifyProductionInfrastructure().catch((e) => e);
    expect(err).toBeInstanceOf(ProductionDependencyError);
    expect(err.dependency).toBe("postgres");
    expect(err.message).toContain("PostgreSQL");

    // Must fail fast - never proceed to check Redis once Postgres is down.
    expect(redisConnectMock).not.toHaveBeenCalled();
  });

  it("in production, throws ProductionDependencyError('redis') when Redis is unreachable, and never silently continues", async () => {
    mockEnv.NODE_ENV = "production";
    redisConnectMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const err = await verifyProductionInfrastructure().catch((e) => e);
    expect(err).toBeInstanceOf(ProductionDependencyError);
    expect(err.dependency).toBe("redis");
    expect(err.message).toContain("Redis");
    expect(err.message.toLowerCase()).toContain("no in-memory queue fallback");

    // The failed probe connection is still cleaned up.
    expect(redisDisconnectMock).toHaveBeenCalled();
  });

  it("in production, does NOT throw when only Elasticsearch is unreachable - Postgres/Redis are the hard requirements", async () => {
    mockEnv.NODE_ENV = "production";
    esPingMock.mockRejectedValue(new Error("ES down"));

    await expect(verifyProductionInfrastructure()).resolves.toBeUndefined();
    expect(queryRawMock).toHaveBeenCalled();
    expect(redisPingMock).toHaveBeenCalled();
    expect(esPingMock).toHaveBeenCalled();
  });
});
