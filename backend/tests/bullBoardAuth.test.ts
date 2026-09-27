import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// bullBoard.ts pulls in the real emailQueue (src/queues/emailQueue.ts),
// which instantiates a real BullMQ Queue backed by a real Redis connection
// at module load. Mock it so mounting Bull Board in this test never touches
// the network - BullMQAdapter only reads `.name` off the queue at mount
// time, so a minimal stub is enough.
vi.mock("../src/queues/emailQueue", () => ({
  emailQueue: { name: "email-send-queue" },
}));

import { requireAuth } from "../src/middleware/requireAuth";
import { mountBullBoard } from "../src/lib/bullBoard";

// NOTE on why this doesn't import src/server.ts directly: server.ts calls
// main() (which hits Elasticsearch, Postgres/Redis via recovery, and
// app.listen()) as an unconditional side effect of being imported, and
// doesn't export its `app`. Reproducing not-yet-supported in this project's
// existing test setup, so instead this test builds a minimal app that
// mounts /admin/queues with the *exact same* two pieces server.ts wires
// together - the real requireAuth middleware and the real mountBullBoard()
// - in the same order, and exercises real HTTP requests against it.
describe("/admin/queues - Bull Board authentication", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();

    // Mirrors cookie-session's contract: it populates req.session before
    // any route-level middleware runs. Here, a request is "authenticated"
    // iff it sends the x-test-user-id header.
    app.use((req: any, _res, next) => {
      const userId = req.headers["x-test-user-id"];
      req.session = userId ? { userId } : undefined;
      next();
    });

    // Exactly the wiring added to src/server.ts for this fix:
    //   app.use("/admin/queues", requireAuth, mountBullBoard("/admin/queues"));
    app.use("/admin/queues", requireAuth, mountBullBoard("/admin/queues"));

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("rejects an unauthenticated request with 401 and never reaches Bull Board", async () => {
    const res = await fetch(`${baseUrl}/admin/queues/`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Not authenticated" });
  });

  it("rejects a request with no session at all (not just a missing userId)", async () => {
    const res = await fetch(`${baseUrl}/admin/queues/api/queues`);
    expect(res.status).toBe(401);
  });

  it("lets an authenticated request through past requireAuth into Bull Board", async () => {
    const res = await fetch(`${baseUrl}/admin/queues/`, {
      headers: { "x-test-user-id": "user-1" },
    });
    // Bull Board's own router now handles the request - whatever it
    // returns, it must not be requireAuth's 401.
    expect(res.status).not.toBe(401);
  });
});
