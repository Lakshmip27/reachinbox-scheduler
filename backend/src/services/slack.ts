import { prisma } from "../lib/prisma";
import { logger } from "../config/logger";
import { env } from "../config/env";

export function getSlackAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID ?? "",
    scope: "chat:write,incoming-webhook",
    redirect_uri: env.SLACK_REDIRECT_URI ?? "",
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(code: string) {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID ?? "",
      client_secret: env.SLACK_CLIENT_SECRET ?? "",
      code,
      redirect_uri: env.SLACK_REDIRECT_URI ?? "",
    }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    access_token: string;
    team: { name: string };
    incoming_webhook?: { url: string; channel_id: string };
  };
  if (!data.ok) {
    throw new Error(`Slack OAuth exchange failed: ${data.error}`);
  }
  return data;
}

/**
 * Send a live Slack notification when a sender's hourly rate limit is hit.
 * Silently no-ops (just logs) if the user hasn't connected Slack - per spec,
 * this must never throw or crash the worker, and must start working
 * immediately (no redeploy) once they do connect, since we look the
 * integration up fresh from the DB on every call rather than caching it.
 */
export async function notifyRateLimitHit(params: {
  userId: string;
  senderLabel: string;
  hourlyLimit: number;
  nextWindowStart: number;
}) {
  const integration = await prisma.slackIntegration.findUnique({
    where: { userId: params.userId },
  });

  if (!integration) {
    logger.info(
      { userId: params.userId },
      "Rate limit hit but no Slack integration connected - skipping notification"
    );
    return;
  }

  const text = `⚠️ *Rate limit reached* for sender *${params.senderLabel}* (${params.hourlyLimit}/hr). Remaining emails have been rescheduled to the next hour window (${new Date(
    params.nextWindowStart
  ).toLocaleString()}).`;

  try {
    if (integration.webhookUrl) {
      const res = await fetch(integration.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
    } else {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${integration.accessToken}`,
        },
        body: JSON.stringify({ channel: integration.channelId, text }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    }
    logger.info({ userId: params.userId }, "Slack rate-limit notification sent");
  } catch (err) {
    // A Slack outage should never take down the scheduler.
    logger.error({ err, userId: params.userId }, "Failed to send Slack notification");
  }
}
