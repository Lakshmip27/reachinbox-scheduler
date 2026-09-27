import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue } from "../queues/emailQueue";

export function mountBullBoard(basePath: string) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  // @bull-board/api's BaseAdapter type and the installed bullmq Job type
  // disagree structurally on `progress` across their current published
  // versions (a known upstream mismatch, not a bug in this code) - this
  // works correctly at runtime, so we cast past the structural check.
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue) as any],
    serverAdapter,
  });

  return serverAdapter.getRouter();
}
