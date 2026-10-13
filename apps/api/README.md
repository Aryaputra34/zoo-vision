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
| `ENGINE_TOKEN` | at least 32 characters (`openssl rand -hex 32`); the engine sends it as `Authorization: Bearer` to `/internal/engine/*` |
| `COOKIE_SECURE` | `true` (default) or `false` (plain HTTP, before TLS) |
| `SWAGGER` | `off` (default) or `public` |
| `PORT` | default `3001` |
| `INGEST` | `on` (default) or `off`: whether this process consumes the Redis stream |
| `JOBS` | `on` (default) or `off`: whether this process runs background jobs (the camera offline check, every 5 s) |
| `MODELS_DIR` | default `/data/models`: the AI models folder (`inbox/`, `registry/`, built-ins in the root), shared with the engine |
| `MODEL_UPLOAD_MAX_BYTES` | default 1 GiB: the largest ONNX file the web upload accepts |

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

**First decide whether you need one.** Use-case data (event, interval and metric `data`, and camera
settings) lives in JSONB and is defined by `packages/contracts`. Adding a field there is a contract
change (`npm run generate`), not a migration: only add optional fields, and bump the use case's
`schemaVersion` for a breaking change (see `packages/contracts/README.md`). A Prisma migration is for the
structural tables (`User`, `Camera`, `ApiToken`, logs, …), new tables and new indexes.

To change the schema, edit `prisma/schema.prisma`, then create the migration against a local database.
With `deploy/docker-compose.override.yml` the compose Postgres is on `127.0.0.1:5433`:

```
# bash
DATABASE_MIGRATE_URL=postgresql://zoo_owner:<POSTGRES_PASSWORD>@127.0.0.1:5433/zoo_vision \
  npx prisma migrate dev --create-only --name <change>
# PowerShell
$env:DATABASE_MIGRATE_URL = "postgresql://zoo_owner:<POSTGRES_PASSWORD>@127.0.0.1:5433/zoo_vision"
npx prisma migrate dev --create-only --name <change>
```

`--create-only` writes `prisma/migrations/<timestamp>_<change>/migration.sql` without applying it. Read
the SQL, add grants if needed (below), then run `npx prisma migrate dev` to apply it and regenerate the
client. Run `npm run test:e2e`: its setup applies every migration to a fresh database and connects as
`zoo_api`, so missing grants show up there. Commit `schema.prisma` and the migration folder together.

**Rule: every migration that adds a table also adds its `GRANT`s for `zoo_api`.** Prisma does not
diff grants, so write them by hand in the same migration (see `*_db_roles`). `Event`, `AuditLog`,
`LoginLog` and `DeadEvent` stay SELECT + INSERT only; `Interval` and `Metric` allow UPDATE only on
the columns listed there. `test/append-only.e2e-spec.ts` fails if a table has no SELECT grant. New
columns on `User`, `Camera` and `ApiToken` are covered by their table-level grants.

Rules that keep migrations safe:

- Never edit a migration that has been applied anywhere; add a new one. Prisma records each applied
  migration with a checksum.
- There are no down migrations. To undo, restore a backup or write a new migration that reverses the
  change. The update steps in `deploy/README.md` start with a backup for this reason.
- Prefer additive changes: a new nullable column, or one with a default, is always safe. To rename or drop
  a column, add the new one, switch the code, and drop the old one in a later release, so a running API
  never hits a missing column.
- A forgotten grant shows up as permission errors in `docker compose logs api`. The event consumer retries
  instead of dead-lettering (class 42 errors count as transient), so no data is lost, but check the log
  after every update.

Deployments run `npx prisma migrate deploy` in the API image with `DATABASE_MIGRATE_URL` set: the
one-shot `api-migrate` service applies the pending migrations in order before the API starts
(`docker compose up -d --build api-migrate api`).

## Engine routes

`/internal/engine/*` belongs to the Python engine. The routes sit outside the `api` prefix and outside
URI versioning, are never routed by Caddy, and are left out of Swagger. Each needs
`Authorization: Bearer <ENGINE_TOKEN>` (compared in constant time); a user session or API token is not
accepted. Anything else is 401.

| Route | Returns |
|---|---|
| `GET /internal/engine/cameras?group=<g>` | `{"cameras": EngineCamera[]}`: the enabled cameras of engine group `g` (`^[a-z0-9_-]{1,32}$`, else 400), sorted by id. Each has its active settings with schema defaults filled in, the decrypted `sourceUrl` (the sub stream when `inferenceStream` is `SUB` and a sub URL is set), `targetFps`, `nxCameraId` and `model` |

The engine also reports the result of a model job: `POST /internal/engine/models/:id/validation` and
`POST /internal/engine/models/:id/conversion` (both 204). The API queues the jobs on the Redis list
`model:jobs`.

## Cameras, live status and models

User routes under `/api/v1`:

| Route | Role | What it does |
|---|---|---|
| `GET /camera-status` | any | Per camera: `online` (the engine reported within 15 s) and its `status` (`state`, `appliedVersion`, ...), or null |
| `GET /cameras/:id/status` | any | The same for one camera |
| `GET /cameras/:id/frame` | any | The latest JPEG from the engine (404 until it sends one) |
| `GET /models`, `GET /models/:id` | MANAGER | List and read AI models |
| `POST /models` | SUPERADMIN | Upload an ONNX file (multipart). `.pt` and `.engine` files are refused: copy them into `inbox/` |
| `POST /models/rescan` | SUPERADMIN | Register the files in `inbox/` and the built-ins in the models root |
| `POST /models/:id/validate`, `POST /models/:id/convert` | SUPERADMIN | Queue a validation, or a conversion to ONNX, for the engine |
| `DELETE /models/:id` | SUPERADMIN | Remove a model |

A conversion whose report never reaches the API (the engine was stopped or could not reach the API) leaves the
target row in `CONVERTING`. Validate cannot retry it: `POST /models/:id/validate` answers 409 ("The model is
being converted"), and a converted row that ended `FAILED` has no file to validate. To try again, delete the
target row (`DELETE /models/:id`) and start the conversion again from the source model.

A camera has `inferenceStream` (`MAIN` or `SUB`): which stream URL the engine analyses. The engine applies camera
changes live, so saving settings does not restart its stream.

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
