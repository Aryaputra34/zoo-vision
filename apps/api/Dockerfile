# syntax=docker/dockerfile:1
# Build context is the repository root (the API depends on packages/contracts):
#   docker build -f apps/api/Dockerfile -t zoo-vision-api:dev .
# The same image runs the API (default CMD) and the one-shot migration:
#   npx prisma migrate deploy   (with DATABASE_MIGRATE_URL for zoo_owner)

FROM node:22-bookworm-slim AS build
# Prisma's schema engine (prisma migrate) needs OpenSSL
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Runtime deps only: Node resolves them from the package's real path, not through the link.
COPY packages/contracts/package.json packages/contracts/package-lock.json packages/contracts/
RUN cd packages/contracts && npm ci --omit=dev
COPY packages/contracts/ packages/contracts/

# npm ci runs `prisma generate` (postinstall), which needs the schema and the config.
COPY apps/api/package.json apps/api/package-lock.json apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma/ apps/api/prisma/
RUN cd apps/api && npm ci
COPY apps/api/ apps/api/
RUN cd apps/api \
 && npx prisma generate \
 && npm run build \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/packages/contracts packages/contracts
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts /app/apps/api/package.json apps/api/
WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
