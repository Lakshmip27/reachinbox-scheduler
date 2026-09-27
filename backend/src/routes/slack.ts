import { Router } from "express";
import { randomUUID } from "crypto";
import { getSlackAuthorizeUrl, exchangeSlackCode } from "../services/slack";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { requireAuth } from "../middleware/requireAuth";
import { logger } from "../config/logger";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

router.get("/connect", requireAuth, (req, res) => {
  const state = randomUUID();
  (req.session as any).slackOauthState = state;
  res.redirect(getSlackAuthorizeUrl(state));
});

router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    const userId = (req.session as any)?.userId;
    if (!userId) return res.redirect(`${env.FRONTEND_URL}/login`);
    if (!code || state !== (req.session as any).slackOauthState) {
      return res.redirect(`${env.FRONTEND_URL}/dashboard?slack=error`);
    }

    const data = await exchangeSlackCode(code);

    await prisma.slackIntegration.upsert({
      where: { userId },
      update: {
        teamName: data.team?.name,
        accessToken: data.access_token,
        webhookUrl: data.incoming_webhook?.url,
        channelId: data.incoming_webhook?.channel_id,
      },
      create: {
        userId,
        teamName: data.team?.name,
        accessToken: data.access_token,
        webhookUrl: data.incoming_webhook?.url,
        channelId: data.incoming_webhook?.channel_id,
      },
    });

    res.redirect(`${env.FRONTEND_URL}/dashboard?slack=connected`);
  } catch (err) {
    logger.error({ err }, "Slack OAuth callback failed");
    res.redirect(`${env.FRONTEND_URL}/dashboard?slack=error`);
  }
});

router.post("/disconnect", requireAuth, asyncHandler(async (req, res) => {
  const userId = (req.session as any).userId;
  await prisma.slackIntegration.deleteMany({ where: { userId } });
  res.json({ ok: true });
}));

export default router;
