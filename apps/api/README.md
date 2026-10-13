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

**Rule: every migration that adds a table also adds its `GRANT`s for `zoo_api`.** Prisma does not
diff grants, so write them by hand in the same migration (see `*_db_roles`). `Event`, `AuditLog`,
`LoginLog` and `DeadEvent` stay SELECT + INSERT only; `Interval` and `Metric` allow UPDATE only on
the columns listed there. `test/append-only.e2e-spec.ts` fails if a table has no SELECT grant.

Deployments run `npx prisma migrate deploy` in the API image with `DATABASE_MIGRATE_URL` set.

## Docker

Build from the repository root (the image includes `packages/contracts`):

```
docker build -f apps/api/Dockerfile -t zoo-vision-api:dev .
```

## Run it with Compose

`deploy/docker-compose.yml` runs Postgres, Redis, a one-shot `api-migrate` and this API. See
[`deploy/README.md`](../../deploy/README.md) for the secrets and the laptop (no GPU) command, and
[`docs/10_LOCAL_QUICKSTART.md`](../../docs/10_LOCAL_QUICKSTART.md) for creating the first superadmin and importing
cameras. The CLI inside the image: `node dist/cli.js create-superadmin --username admin --name "..."` with
`ZOO_ADMIN_PASSWORD` in the environment.
