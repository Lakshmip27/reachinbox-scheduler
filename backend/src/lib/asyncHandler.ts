import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async Express route handler so that a rejected promise (e.g. an
 * awaited Prisma/Redis/Elasticsearch/SMTP call that throws) is forwarded to
 * `next(err)` - and from there to the centralized error handler in
 * errorHandler.ts - instead of becoming an unhandled promise rejection,
 * which Express 4 does not catch on its own for async handlers.
 *
 * This changes nothing about what a handler does on success: it only adds
 * a `.catch(next)` around the returned promise. Any `res.status(...).json(...)`
 * a handler already sends itself (including existing Zod `safeParse` 400
 * responses) is completely unaffected, since those are normal returns, not
 * rejections.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}
