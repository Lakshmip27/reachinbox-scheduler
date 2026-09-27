import { Client } from "@elastic/elasticsearch";
import { env } from "../config/env";
import { logger } from "../config/logger";

export const esClient = new Client({ node: env.ELASTICSEARCH_NODE });

export const EMAIL_INDEX = env.ELASTICSEARCH_INDEX;

export async function ensureEmailIndex() {
  const exists = await esClient.indices.exists({ index: EMAIL_INDEX });
  if (exists) return;

  await esClient.indices.create({
    index: EMAIL_INDEX,
    mappings: {
      properties: {
        scheduledEmailId: { type: "keyword" },
        userId: { type: "keyword" },
        recipient: { type: "text", fields: { keyword: { type: "keyword" } } },
        subject: { type: "text" },
        bodyHtml: { type: "text" },
        status: { type: "keyword" },
        senderId: { type: "keyword" },
        campaignId: { type: "keyword" },
        scheduledAt: { type: "date" },
        sentAt: { type: "date" },
      },
    },
  });
  logger.info({ index: EMAIL_INDEX }, "Created Elasticsearch index");
}

export interface IndexableEmail {
  scheduledEmailId: string;
  userId: string;
  recipient: string;
  subject: string;
  bodyHtml: string;
  status: string;
  senderId: string;
  campaignId: string;
  scheduledAt: Date;
  sentAt?: Date | null;
}

/** Upsert a single email doc - called on create and on every status change. */
export async function indexEmail(doc: IndexableEmail) {
  try {
    await esClient.index({
      index: EMAIL_INDEX,
      id: doc.scheduledEmailId,
      document: doc,
      refresh: false,
    });
  } catch (err) {
    // Search indexing must never break the send/schedule pipeline - log and move on.
    logger.error({ err, id: doc.scheduledEmailId }, "Failed to index email in Elasticsearch");
  }
}

export interface SearchEmailsParams {
  userId: string; // required, not optional: every search MUST be scoped to a user
  query?: string;
  status?: string;
  senderId?: string;
  from?: number;
  size?: number;
}

export async function searchEmails(params: SearchEmailsParams) {
  // userId is always a mandatory term filter, first in the list, so tenant
  // isolation can never be bypassed by omitting it - see routes/emails.ts,
  // which is the only caller and always passes the session's own userId.
  const must: any[] = [{ term: { userId: params.userId } }];

  if (params.query) {
    must.push({
      multi_match: {
        query: params.query,
        fields: ["subject", "bodyHtml", "recipient"],
      },
    });
  }
  if (params.status) must.push({ term: { status: params.status } });
  if (params.senderId) must.push({ term: { senderId: params.senderId } });

  const result = await esClient.search({
    index: EMAIL_INDEX,
    from: params.from ?? 0,
    size: params.size ?? 25,
    query: { bool: { must } },
    sort: [{ scheduledAt: { order: "desc" } }],
  });

  return result.hits.hits.map((hit) => hit._source);
}
