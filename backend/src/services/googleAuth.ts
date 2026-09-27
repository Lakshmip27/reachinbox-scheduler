import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";

export const googleClient = new OAuth2Client(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_CALLBACK_URL
);

export function getGoogleAuthUrl(state: string) {
  return googleClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
  });
}

export async function handleGoogleCallback(code: string) {
  const { tokens } = await googleClient.getToken(code);
  googleClient.setCredentials(tokens);

  const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token!,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("Google account has no email");

  const user = await prisma.user.upsert({
    where: { email: payload.email },
    update: {
      googleId: payload.sub,
      name: payload.name,
      avatarUrl: payload.picture,
    },
    create: {
      email: payload.email,
      googleId: payload.sub,
      name: payload.name,
      avatarUrl: payload.picture,
    },
  });

  return user;
}
