import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { enqueueEmailJob } from "../queues/emailQueue";
import { indexEmail } from "../services/searchIndex";
import { extractEmailsFromFile } from "../lib/parseLeads";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Lets the frontend show "X email addresses detected" right after upload,
// before the user has filled in subject/schedule/etc and hit "Schedule".
router.post("/parse-leads", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const emails = extractEmailsFromFile(req.file.buffer);
  res.json({ count: emails.length, emails });
});

const composeSchema = z.object({
  senderId: z.string().uuid(),
  subject: z.string().min(1),
  bodyHtml: z.string().min(1),
  startTime: z.coerce.date(),
  delayMs: z.coerce.number().int().nonnegative(),
  hourlyLimit: z.coerce.number().int().positive(),
});

router.post("/", upload.single("file"), asyncHandler(async (req, res) => {
  const parsed = composeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.file) return res.status(400).json({ error: "Leads file is required" });

  const userId = (req.session as any).userId;
  const { senderId, subject, bodyHtml, startTime, delayMs, hourlyLimit } = parsed.data;

  const sender = await prisma.sender.findFirst({ where: { id: senderId, userId } });
  if (!sender) return res.status(404).json({ error: "Sender not found" });

  const emails = extractEmailsFromFile(req.file.buffer);
  if (emails.length === 0) {
    return res.status(400).json({ error: "No valid email addresses found in the uploaded file" });
  }

  // delayMs / hourlyLimit are stored ONLY on this Campaign row and read by
  // the worker per-job via emailRow.campaign - see rateLimiter.ts and
  // emailWorker.ts. We deliberately do NOT touch the Sender row here:
  // composing a second campaign from the same sender must not clobber or
  // share rate-limit state with a campaign that's still in flight.
  const campaign = await prisma.campaign.create({
    data: { userId, subject, bodyHtml, startTime, delayMs, hourlyLimit },
  });

  // Under-load behavior (spec 2.3): even for 1000+ recipients scheduled "at
  // once", we don't enqueue them all with delay=0. We pre-stagger their
  // intended `scheduledAt` by `delayMs * index` at creation time. This keeps
  // relative order stable and gives the hourly-cap check something sane to
  // measure against; the *actual* enforcement (in case the pre-stagger still
  // exceeds the cap) happens for real in the worker via rateLimiter.ts,
  // which pushes overflow into the next hour window automatically.
  const created = await prisma.$transaction(
    emails.map((recipient, i) =>
      prisma.scheduledEmail.create({
        data: {
          campaignId: campaign.id,
          senderId,
          userId,
          recipient,
          subject,
          bodyHtml,
          scheduledAt: new Date(startTime.getTime() + i * delayMs),
          status: "SCHEDULED",
        },
      })
    )
  );

  for (const row of created) {
    await enqueueEmailJob(
      {
        scheduledEmailId: row.id,
        senderId,
        recipient: row.recipient,
        subject: row.subject,
        bodyHtml: row.bodyHtml,
      },
      row.scheduledAt,
      { jobId: row.id }
    );
    await prisma.scheduledEmail.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await indexEmail({
      scheduledEmailId: row.id,
      userId,
      recipient: row.recipient,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      status: "SCHEDULED",
      senderId,
      campaignId: campaign.id,
      scheduledAt: row.scheduledAt,
    });
  }

  res.status(201).json({ campaign, scheduledCount: created.length });
}));

export default router;
