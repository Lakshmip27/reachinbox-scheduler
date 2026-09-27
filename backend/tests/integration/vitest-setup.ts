// Runs BEFORE any test file (and therefore before any `src/` module) is
// imported. `src/config/env.ts` calls `dotenv/config` and then validates
// `process.env` with zod on import - dotenv never overrides a variable that
// is already set, so anything we set here wins over a repo-root `.env` and
// is itself overridden by whatever the shell/CI already exported. This lets
// `npm run test:integration` work out of the box against the default
// `docker compose up -d postgres redis` stack, while still respecting a
// developer's own `.env` or CI secrets when present.

function setDefault(key: string, value: string) {
  if (!process.env[key]) process.env[key] = value;
}

setDefault("NODE_ENV", "test");
setDefault(
  "DATABASE_URL",
  "postgresql://reachinbox:reachinbox@localhost:5432/reachinbox?schema=public",
);
setDefault("REDIS_HOST", "127.0.0.1");
setDefault("REDIS_PORT", "6379");
