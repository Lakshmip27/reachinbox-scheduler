import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const findManyMock = vi.fn();
const createMock = vi.fn();

// Mock Prisma so no real DB is needed, but keep the mock's `create`
// implementation faithful to Prisma's real `select` behavior (only the
// requested fields come back) - that's what makes this test actually prove
// something about senders.ts's own code, rather than just about the mock.
vi.mock("../src/lib/prisma", () => ({
  prisma: {
    sender: {
      findMany: (...args: any[]) => findManyMock(...args),
      create: (...args: any[]) => createMock(...args),
    },
  },
}));

const createEtherealTestAccountMock = vi.fn();
vi.mock("../src/services/mailer", () => ({
  createEtherealTestAccount: (...args: any[]) => createEtherealTestAccountMock(...args),
}));

import sendersRouter from "../src/routes/senders";

// A full DB row, as Prisma would actually construct it - including the
// secret fields. Used by the create() mock below to simulate Prisma's own
// `select` field-filtering, so this test fails if senders.ts ever stops
// passing `select` (or starts selecting smtpPass) on the create() call.
function buildFullRow(data: any) {
  return {
    id: "sender-1",
    userId: data.userId,
    label: data.label,
    smtpHost: data.smtpHost,
    smtpPort: data.smtpPort,
    smtpUser: data.smtpUser,
    smtpPass: data.smtpPass,
    maxEmailsPerHour: data.maxEmailsPerHour,
    minDelayMs: data.minDelayMs,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function applyPrismaSelect(row: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return row;
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) filtered[key] = row[key];
  }
  return filtered;
}

describe("/api/senders - SMTP credential exposure", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Stand-in for cookie-session: always "logged in" as user-1, mirroring
    // how requireAuth reads req.session in the real app.
    app.use((req: any, _res, next) => {
      req.session = { userId: "user-1" };
      next();
    });
    app.use("/api/senders", sendersRouter);

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    findManyMock.mockReset();
    createMock.mockReset();
    createEtherealTestAccountMock.mockReset();

    createEtherealTestAccountMock.mockResolvedValue({
      user: "smtp-user@ethereal.email",
      pass: "super-secret-smtp-password",
    });

    createMock.mockImplementation(async ({ data, select }: any) => {
      const fullRow = buildFullRow(data);
      return applyPrismaSelect(fullRow, select);
    });

    findManyMock.mockImplementation(async ({ select }: any) => {
      const fullRow = buildFullRow({
        userId: "user-1",
        label: "Existing sender",
        smtpHost: "smtp.ethereal.email",
        smtpPort: 587,
        smtpUser: "existing@ethereal.email",
        smtpPass: "another-secret-password",
        maxEmailsPerHour: 200,
        minDelayMs: 2000,
      });
      return [applyPrismaSelect(fullRow, select)];
    });
  });

  it("POST /api/senders never returns smtpPass (or any other SMTP credential) in the response", async () => {
    const res = await fetch(`${baseUrl}/api/senders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "My new sender" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // The critical assertions: the raw secret value must not appear
    // anywhere in the response, under any key.
    expect(JSON.stringify(body)).not.toContain("super-secret-smtp-password");
    expect(body).not.toHaveProperty("smtpPass");
    expect(body).not.toHaveProperty("smtpHost");
    expect(body).not.toHaveProperty("smtpPort");

    // Still returns the fields the frontend actually needs.
    expect(body).toMatchObject({
      id: "sender-1",
      label: "My new sender",
      smtpUser: "smtp-user@ethereal.email",
      maxEmailsPerHour: 200,
      minDelayMs: 2000,
    });
    expect(body).toHaveProperty("createdAt");

    // Confirms the fix is a `select` on the create() call, not just a
    // response-shaping accident: prisma.sender.create must never have been
    // asked to select smtpPass.
    const createArgs = createMock.mock.calls[0][0];
    expect(createArgs.select).toBeDefined();
    expect(createArgs.select.smtpPass).not.toBe(true);
  });

  it("GET /api/senders never returns smtpPass in the list response", async () => {
    const res = await fetch(`${baseUrl}/api/senders`);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("another-secret-password");
    for (const sender of body) {
      expect(sender).not.toHaveProperty("smtpPass");
      expect(sender).not.toHaveProperty("smtpHost");
      expect(sender).not.toHaveProperty("smtpPort");
    }

    const findManyArgs = findManyMock.mock.calls[0][0];
    expect(findManyArgs.select.smtpPass).not.toBe(true);
  });
});
