import "dotenv/config";
import { z } from "zod";

// Central place that validates and exposes all env vars.
// Nothing in the app should read process.env directly outside this file -
// that's what makes "no hardcoded limits" easy to prove in a review.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  ELASTICSEARCH_NODE: z.string().default("http://localhost:9200"),
  ELASTICSEARCH_INDEX: z.string().default("reachinbox_emails"),

  // Global default rate limit fallback (per-sender values in DB override this
  // when set on the Sender row - see rateLimiter.ts)
  MAX_EMAILS_PER_HOUR: z.coerce.number().default(200),
  MIN_DELAY_MS: z.coerce.number().default(2000),
  WORKER_CONCURRENCY: z.coerce.number().default(5),

  ETHEREAL_SMTP_HOST: z.string().default("smtp.ethereal.email"),
  ETHEREAL_SMTP_PORT: z.coerce.number().default(587),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),

  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),

  SESSION_SECRET: z.string().default("dev-secret-change-me"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud - a misconfigured env is the #1 cause of "works on my
  // machine" bugs in a project with this many moving parts (Redis/DB/ES/OAuth).
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
