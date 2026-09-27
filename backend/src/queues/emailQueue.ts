import { Queue } from "bullmq";
import { createRedisConnection } from "../lib/redis";

export const EMAIL_QUEUE_NAME = "email-send-queue";

export interface EmailJobData {
  scheduledEmailId: string; // DB row id - the source of truth
  senderId: string;
  recipient: string;
  subject: string;
  bodyHtml: string;
}

// One Queue instance, reused everywhere. BullMQ persists all job data
// (payload, delay, state, retry count) in Redis, so this queue IS the
// durable schedule - there is no separate cron or in-memory timer.
export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    // Keep a trail for debugging/dashboard, but don't grow Redis forever.
    removeOnComplete: { age: 60 * 60 * 24 * 7, count: 5000 },
    removeOnFail: { age: 60 * 60 * 24 * 30 },
  },
});

/**
 * Enqueue (or re-enqueue) a scheduled email as a BullMQ delayed job.
 *
 * Idempotency: we pass `jobId: scheduledEmailId`. BullMQ guarantees at most
 * one job can exist with a given jobId in a queue - calling add() again with
 * the same id is a no-op if that job already exists (it returns the existing
 * job rather than creating a duplicate). This protects the *enqueue* step:
 * calling this function twice for the same email never creates two jobs.
 * The *send* step has a separate, weaker guarantee - see the "Delivery
 * semantics" note in emailWorker.ts and README §4.6 before assuming this
 * adds up to exactly-once SMTP delivery.
 */
export async function enqueueEmailJob(
  data: EmailJobData,
  runAt: Date,
  opts?: { jobId?: string }
) {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  const jobId = opts?.jobId ?? data.scheduledEmailId;

  return emailQueue.add("send-email", data, {
    jobId,
    delay,
  });
}
