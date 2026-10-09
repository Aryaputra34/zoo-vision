# @zoo-vision/api

The Zoo Vision backend: NestJS 11 + Prisma 7 on Postgres 17 and Redis 7.4. Routes live under
`/api/v1/...`; the health check is `GET /api/health`; Swagger is at `/api/docs` (JSON at
`/api/docs-json`) when `SWAGGER=public`.

## Setup

```
cd packages/contracts && npm ci --omit=dev   # the contracts package's runtime deps (ajv)
cd apps/api && npm ci                        # also runs `prisma generate` into src/generated/
```

## Environment

Checked at boot: the app refuses to start and lists every bad variable.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres as the `zoo_api` role (the running API) |
| `REDIS_URL` | `redis://[:password@]host:port/db` |
| `CAMERA_URL_KEY` | base64 of 32 random bytes (`openssl rand -base64 32`); encrypts stored camera stream URLs |
| `COOKIE_SECURE` | `true` (default) or `false` (plain HTTP, before TLS) |
| `SWAGGER` | `off` (default) or `public` |
| `PORT` | default `3001` |
| `INGEST` | `on` (default) or `off`: whether this process consumes the Redis stream |

The Prisma CLI reads only `DATABASE_MIGRATE_URL` (Postgres as the owner role `zoo_owner`), from
`prisma.config.ts`. The running API never has the owner password.

## Scripts

```
npm run build        # dist/
npm run start:dev    # watch mode
npm run lint
npm test             # unit tests (src/**/*.spec.ts)
npm run test:e2e     # needs Docker: Testcontainers starts Postgres and Redis
```

The e2e global setup starts `postgres:17.11-alpine` and `redis:7.4.11-alpine`, runs
`prisma migrate deploy` as `zoo_owner`, gives the `zoo_api` role a login and points
`DATABASE_URL` at it. Helpers: `test/app.ts` (`createTestApp(env?)`) and `test/setup/db.ts`
(`resetDb`, `ownerQuery`, `flushRedis`).

## Migrations

Edit `prisma/schema.prisma`, then against a local database:

```
DATABASE_MIGRATE_URL=postgresql://zoo_owner:...@localhost:5432/zoo_vision npx prisma migrate dev --name <change>
```

Deployments run `npx prisma migrate deploy` in the API image with `DATABASE_MIGRATE_URL` set.

## Docker

Build from the repository root (the image includes `packages/contracts`):

```
docker build -f apps/api/Dockerfile -t zoo-vision-api:dev .
```
