import { Request, Response, NextFunction } from "express";

// cookie-session attaches `req.session` at runtime; we don't need the
// express-session package types (we're using cookie-session), so we just
// widen the type loosely here rather than augmenting a module that isn't installed.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = (req as any).session;
  if (!session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}
