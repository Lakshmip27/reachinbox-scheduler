# syntax=docker/dockerfile:1

# ---- deps: install all deps (incl. dev, since we need the Prisma CLI and
# TypeScript compiler both at build time AND at container-start time for
# `prisma migrate deploy`) ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: generate Prisma client + compile TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---- runtime: shared by both the "backend" and "worker" compose services.
# Keeps full node_modules (not trimmed to prod-only) so `prisma migrate
# deploy` can run from this same image at container start. ----
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 4000

# Default command: run pending migrations, then start the API server.
# The "worker" compose service overrides this command to run
# dist/workers/emailWorker.js instead, reusing this exact image.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
