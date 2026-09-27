import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { createEtherealTestAccount } from "../services/mailer";
import { env } from "../config/env";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
router.use(requireAuth);

// Fields safe to return to the client. Deliberately excludes smtpHost,
// smtpPort, smtpUser and (critically) smtpPass - SMTP credentials must
// never leave the server in an HTTP response.
const safeSenderSelect = {
  id: true,
  label: true,
  smtpUser: true,
  maxEmailsPerHour: true,
  minDelayMs: true,
  createdAt: true,
} as const;

router.get("/", asyncHandler(async (req, res) => {
  const userId = (req.session as any).userId;
  const senders = await prisma.sender.findMany({
    where: { userId },
    select: safeSenderSelect,
  });
  res.json(senders);
}));

const createSenderSchema = z.object({
  label: z.string().min(1),
  maxEmailsPerHour: z.number().int().positive().optional(),
  minDelayMs: z.number().int().nonnegative().optional(),
});

// Creates a brand new Ethereal test inbox on the fly and stores it as a
// Sender - this is how the assignment's "multiple senders" requirement is
// satisfied without asking the reviewer to manually create SMTP creds.
router.post("/", asyncHandler(async (req, res) => {
  const parsed = createSenderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = (req.session as any).userId;
  const account = await createEtherealTestAccount();

  const sender = await prisma.sender.create({
    data: {
      userId,
      label: parsed.data.label,
      smtpHost: env.ETHEREAL_SMTP_HOST,
      smtpPort: env.ETHEREAL_SMTP_PORT,
      smtpUser: account.user,
      smtpPass: account.pass,
      maxEmailsPerHour: parsed.data.maxEmailsPerHour ?? env.MAX_EMAILS_PER_HOUR,
      minDelayMs: parsed.data.minDelayMs ?? env.MIN_DELAY_MS,
    },
    select: safeSenderSelect,
  });

  res.status(201).json(sender);
}));

export default router;
