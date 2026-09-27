import { Router } from "express";
import { randomUUID } from "crypto";
import { getGoogleAuthUrl, handleGoogleCallback } from "../services/googleAuth";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

router.get("/google", (req, res) => {
  const state = randomUUID();
  (req.session as any).oauthState = state;
  res.redirect(getGoogleAuthUrl(state));
});

router.get("/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || state !== (req.session as any).oauthState) {
      return res.redirect(`${env.FRONTEND_URL}/login?error=oauth_state_mismatch`);
    }
    const user = await handleGoogleCallback(code);
    (req.session as any).userId = user.id;
    res.redirect(`${env.FRONTEND_URL}/dashboard`);
  } catch (err) {
    logger.error({ err }, "Google OAuth callback failed");
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
  }
});

router.post("/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get("/me", asyncHandler(async (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { slackIntegration: true },
  });
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    slackConnected: Boolean(user.slackIntegration),
  });
}));

export default router;
