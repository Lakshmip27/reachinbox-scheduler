import nodemailer, { Transporter } from "nodemailer";
import { logger } from "../config/logger";

// One transporter per sender (senders have distinct Ethereal SMTP creds),
// cached so we don't re-authenticate on every single send.
const transporterCache = new Map<string, Transporter>();

export interface SenderSmtpConfig {
  id: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
}

function getTransporter(sender: SenderSmtpConfig): Transporter {
  const cached = transporterCache.get(sender.id);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: { user: sender.smtpUser, pass: sender.smtpPass },
  });

  transporterCache.set(sender.id, transporter);
  return transporter;
}

export async function sendEmail(
  sender: SenderSmtpConfig,
  to: string,
  subject: string,
  html: string
) {
  const transporter = getTransporter(sender);
  const info = await transporter.sendMail({
    from: sender.smtpUser,
    to,
    subject,
    html,
  });

  // Ethereal gives back a preview URL - extremely useful for the demo video,
  // since there's no real inbox to screenshot.
  const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
  logger.info({ to, subject, previewUrl }, "Email sent via Ethereal");
  return { messageId: info.messageId, previewUrl };
}

/**
 * Convenience helper for creating a fresh Ethereal test account at runtime
 * (used by the seed script / sender-creation route so a user doesn't have to
 * manually sign up at ethereal.email).
 */
export async function createEtherealTestAccount() {
  return nodemailer.createTestAccount();
}
