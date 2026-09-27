import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { searchEmails } from "../services/searchIndex";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();
router.use(requireAuth);

router.get("/scheduled", asyncHandler(async (req, res) => {
  const userId = (req.session as any).userId;
  const rows = await prisma.scheduledEmail.findMany({
    where: {
      campaign: { userId },
      status: { in: ["PENDING", "SCHEDULED", "PROCESSING", "RATE_LIMITED_REQUEUED"] },
    },
    orderBy: { scheduledAt: "asc" },
    select: {
      id: true,
      recipient: true,
      subject: true,
      scheduledAt: true,
      status: true,
    },
    take: 200,
  });
  res.json(rows);
}));

router.get("/sent", asyncHandler(async (req, res) => {
  const userId = (req.session as any).userId;
  const rows = await prisma.scheduledEmail.findMany({
    where: { campaign: { userId }, status: { in: ["SENT", "FAILED"] } },
    orderBy: { sentAt: "desc" },
    select: {
      id: true,
      recipient: true,
      subject: true,
      sentAt: true,
      status: true,
      lastError: true,
    },
    take: 200,
  });
  res.json(rows);
}));

// Elasticsearch-backed search across both scheduled and sent emails.
// Scoped to the logged-in user only - see searchEmails(), userId is a
// mandatory filter, never optional, so this can't leak across accounts.
router.get("/search", asyncHandler(async (req, res) => {
  const userId = (req.session as any).userId;
  const { q, status, senderId, page } = req.query as Record<string, string>;
  const size = 25;
  const results = await searchEmails({
    userId,
    query: q,
    status,
    senderId,
    from: page ? (Number(page) - 1) * size : 0,
    size,
  });
  res.json(results);
}));

export default router;
