import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";
import { env } from "../config/env";

// Matches common ways a credential ends up embedded in a message or stack
// trace: `key=value` / `key: value` pairs for well-known secret field
// names, `user:password@host` connection-string auth, and bearer tokens.
// Applied to BOTH the server-side log line and any detail we might echo
// back outside production - "don't log/return secrets" is a floor, not
// something that only matters for the HTTP response.
const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|smtp_?pass|access_?token|refresh_?token|authorization)/i;

function redactSecrets(input: string): string {
  let out = input;

  // `postgresql://user:SECRET@host:5432/db`, `redis://:SECRET@host`, etc.
  out = out.replace(/(:\/\/[^:/@\s]*:)([^@\s]+)(@)/g, "$1***$3");

  // `password=foo`, `"smtpPass": "foo"`, `token: foo`, case-insensitive,
  // with or without quotes/colons/equals as separator.
  out = out.replace(
    new RegExp(`(${SECRET_KEY_PATTERN.source})(["']?\\s*[:=]\\s*["']?)([^\\s"',}]+)`, "gi"),
    "$1$2***"
  );

  // `Authorization: Bearer xyz...`
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer ***");

  return out;
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redactSecrets(err.message);
  return redactSecrets(String(err));
}

function safeStack(err: unknown): string | undefined {
  if (err instanceof Error && err.stack) return redactSecrets(err.stack);
  return undefined;
}

/** Routes that don't match any handler - kept as JSON, matching every other endpoint's contract. */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

/**
 * Centralized error handler. Mounted LAST, after every router (see
 * server.ts). Handles:
 *  - ZodErrors thrown directly (e.g. `.parse()` instead of `.safeParse()`)
 *    with the SAME `{ error: zodError.flatten() }` shape the existing
 *    `safeParse` call sites in senders.ts/campaigns.ts already return, so
 *    callers see one consistent contract either way.
 *  - Errors carrying an explicit `status`/`statusCode` (body-parser's
 *    malformed-JSON error, multer's file-size error, etc.) - honored as-is.
 *  - Everything else: 500, with a generic message in production (never the
 *    raw error text, which could echo internal details) and the redacted
 *    message/stack included only outside production, for local debugging.
 *
 * Never touches a response that's already been sent (streaming, redirects
 * already issued, etc.) - just hands off to Express's default handler.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof ZodError) {
    return res.status(400).json({ error: err.flatten() });
  }

  const explicitStatus =
    typeof (err as any)?.status === "number"
      ? (err as any).status
      : typeof (err as any)?.statusCode === "number"
        ? (err as any).statusCode
        : undefined;
  const status = explicitStatus ?? 500;

  // Server-side log: full (redacted) detail regardless of status code, so
  // even a "handled" 4xx that reached here (meaning some code path threw
  // instead of returning its own response) is visible to us.
  logger.error(
    {
      err: { name: err instanceof Error ? err.name : typeof err, message: safeErrorMessage(err), stack: safeStack(err) },
      method: req.method,
      path: req.path,
      status,
    },
    "Unhandled route error"
  );

  const body: Record<string, unknown> = {
    // Never surface a raw internal error message on a 500 - it's server
    // detail, not something a caller can act on, and may not be fully
    // redacted even after our best-effort scrubbing above.
    error: status >= 500 ? "Internal server error" : safeErrorMessage(err) || "Request failed",
  };

  if (env.NODE_ENV !== "production") {
    body.stack = safeStack(err);
  }

  res.status(status).json(body);
};
