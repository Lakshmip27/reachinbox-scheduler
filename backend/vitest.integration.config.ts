import { defineConfig } from "vitest/config";

// Real integration suite: exercises real Postgres (via Prisma) and real
// Redis/BullMQ. Requires `docker compose up -d postgres redis` (see root
// docker-compose.yml) and a migrated database (`npm run prisma:deploy` or
// `npm run prisma:migrate`) before running. Only outbound SMTP,
// Elasticsearch indexing, and Slack notifications are mocked per-test-file
// - everything else here is the real thing.
//
// `fileParallelism: false` is deliberate: these tests share one live
// Postgres/Redis instance and some (recovery) act on ALL pending rows in
// the table, not just their own fixtures, so test files must not run
// concurrently against the same database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.integration.test.ts"],
    setupFiles: ["./tests/integration/vitest-setup.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
