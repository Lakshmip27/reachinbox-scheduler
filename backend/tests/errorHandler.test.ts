import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const loggerErrorMock = vi.fn();
vi.mock("../src/config/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...args: any[]) => loggerErrorMock(...args), debug: vi.fn(), fatal: vi.fn() },
}));

const mockEnv: any = vi.hoisted(() => ({ NODE_ENV: "development" }));
vi.mock("../src/config/env", () => ({ env: mockEnv }));

import { errorHandler, notFoundHandler } from "../src/middleware/errorHandler";
import { asyncHandler } from "../src/lib/asyncHandler";

function buildApp() {
  const app = express();
  app.use(express.json());

  // A normal successful route - proves the error handler never touches
  // successful responses.
  app.get("/ok", (_req, res) => res.json({ ok: true, value: 42 }));

  // Synchronous throw - Express catches this natively even without asyncHandler.
  app.get("/sync-throw", () => {
    throw new Error("boom: password=hunter2 leaked in a sync throw");
  });

  // Async rejection - requires asyncHandler to reach the error middleware
  // at all (Express 4 does not catch this automatically).
  app.get(
    "/async-reject",
    asyncHandler(async () => {
      throw new Error("boom: token=abcdef123456 leaked in an async throw");
    })
  );

  // A route that throws a raw ZodError (as opposed to using safeParse and
  // returning its own 400 - the existing pattern elsewhere in the app).
  const schema = z.object({ name: z.string() });
  app.get(
    "/zod-throw",
    asyncHandler(async (req) => {
      schema.parse(req.query); // .parse (not .safeParse) - throws on failure
      throw new Error("unreachable if validation failed");
    })
  );

  // An error carrying an explicit status, like body-parser/multer errors.
  app.get(
    "/explicit-status",
    asyncHandler(async () => {
      const err: any = new Error("Payload too large");
      err.status = 413;
      throw err;
    })
  );

  // A route whose existing safeParse-based 400 must be completely
  // untouched by adding the error handler elsewhere in the app.
  app.get("/existing-safeparse-style", (req, res) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.json({ ok: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    loggerErrorMock.mockReset();
    mockEnv.NODE_ENV = "development";
    const app = buildApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("does not change a successful response", async () => {
    const res = await fetch(`${baseUrl}/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: 42 });
  });

  it("preserves an existing safeParse-based 400 response exactly as before", async () => {
    const res = await fetch(`${baseUrl}/existing-safeparse-style`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.fieldErrors).toBeDefined(); // zod's .flatten() shape
  });

  it("catches a synchronous throw and returns a consistent JSON 500", async () => {
    const res = await fetch(`${baseUrl}/sync-throw`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("catches an async rejection (via asyncHandler) and returns a consistent JSON 500", async () => {
    const res = await fetch(`${baseUrl}/async-reject`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("formats a thrown ZodError the same way existing safeParse call sites already do", async () => {
    const res = await fetch(`${baseUrl}/zod-throw`); // no ?name= -> fails validation
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.fieldErrors).toBeDefined();
    expect(body.error.fieldErrors.name).toBeDefined();
  });

  it("honors an explicit status set on the error (e.g. body-parser/multer style)", async () => {
    const res = await fetch(`${baseUrl}/explicit-status`);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("Payload too large");
  });

  it("returns 404 JSON for unmatched routes", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("in development, includes a redacted stack trace for debugging", async () => {
    const res = await fetch(`${baseUrl}/sync-throw`);
    const body = await res.json();
    expect(body.stack).toBeDefined();
    expect(body.stack).not.toContain("hunter2");
  });

  it("in production, never includes a stack trace or the raw error message on a 500", async () => {
    mockEnv.NODE_ENV = "production";
    const res = await fetch(`${baseUrl}/async-reject`);
    const body = await res.json();
    expect(body.stack).toBeUndefined();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("abcdef123456");
  });

  it("never logs secrets (password/token) even though the raw error message contained them", async () => {
    await fetch(`${baseUrl}/sync-throw`);
    expect(loggerErrorMock).toHaveBeenCalled();
    const loggedPayload = JSON.stringify(loggerErrorMock.mock.calls[0]);
    expect(loggedPayload).not.toContain("hunter2");
    expect(loggedPayload).toContain("***"); // redaction marker present
  });

  it("redacts a token from the async-reject error before logging", async () => {
    await fetch(`${baseUrl}/async-reject`);
    const loggedPayload = JSON.stringify(loggerErrorMock.mock.calls[0]);
    expect(loggedPayload).not.toContain("abcdef123456");
  });
});
