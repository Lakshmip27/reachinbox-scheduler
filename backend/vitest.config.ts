import { defineConfig } from "vitest/config";

// Unit suite only: pure logic + mocked Prisma/Redis/BullMQ/SMTP/ES/Slack, no
// live infra required. The real-infra integration suite lives under
// tests/integration/ and is intentionally excluded here - it has its own
// config (vitest.integration.config.ts / `npm run test:integration`) since
// it needs a live Postgres + Redis and should not run as part of `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "**/node_modules/**"],
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});
