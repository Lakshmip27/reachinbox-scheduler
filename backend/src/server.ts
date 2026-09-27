import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { mountBullBoard } from "./lib/bullBoard";
import { ensureEmailIndex } from "./services/searchIndex";
import { recoverUnfinishedJobs } from "./services/recovery";
import { requireAuth } from "./middleware/requireAuth";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { verifyProductionInfrastructure, ProductionDependencyError } from "./lib/productionReadiness";

import authRoutes from "./routes/auth";
import slackRoutes from "./routes/slack";
import senderRoutes from "./routes/senders";
import campaignRoutes from "./routes/campaigns";
import emailRoutes from "./routes/emails";

const app = express();

app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(
  cookieSession({
    name: "reachinbox_session",
    secret: env.SESSION_SECRET,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/slack", slackRoutes);
app.use("/api/senders", senderRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/emails", emailRoutes);

// Live BullMQ dashboard - required by the spec for real-time queue visibility.
// Gated behind the same session-based requireAuth used by the rest of the
// API so an unauthenticated caller can't view (or act on) queue internals.
app.use("/admin/queues", requireAuth, mountBullBoard("/admin/queues"));

// Must come after every route: a 404 for anything unmatched, then the
// centralized error handler for anything any route above threw/rejected
// (including via asyncHandler - see src/lib/asyncHandler.ts) or that Zod
// raised directly. Order matters - Express only treats a 4-arg function as
// error-handling middleware, and only errors that reach here (after all
// normal routes) get funneled through it.
app.use(notFoundHandler);
app.use(errorHandler);

async function main() {
  try {
    await verifyProductionInfrastructure();
  } catch (err) {
    if (err instanceof ProductionDependencyError) {
      logger.fatal(
        { dependency: err.dependency, err: err.message },
        "FATAL: a required production dependency is unavailable - refusing to start."
      );
    } else {
      logger.fatal({ err }, "FATAL: production readiness check failed - refusing to start.");
    }
    process.exit(1);
  }

  await ensureEmailIndex().catch((err) =>
    logger.error({ err }, "Could not reach Elasticsearch on boot - search endpoints will fail until it's up")
  );
  await recoverUnfinishedJobs();

  app.listen(env.PORT, () => {
    logger.info(`🚀 ReachInbox scheduler API listening on :${env.PORT}`);
    logger.info(`📊 Bull-Board dashboard: http://localhost:${env.PORT}/admin/queues`);
  });
}

main();
