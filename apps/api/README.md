# @zoo-vision/api

The Zoo Vision backend: NestJS 11 + Prisma 7 on Postgres 17 and Redis 7.4. Routes live under
`/api/v1/...`; the health check is `GET /api/health`; Swagger is at `/api/docs` (JSON at
`/api/docs-json`) according to `SWAGGER` (below).

The frontend builds against three files, pinned by a git tag `contract-vX.Y`: `openapi.json` (this folder),
`packages/contracts/generated/web/index.d.ts` and `docs/fe-contract.md`.

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
| `SWAGGER` | `off` (default), `superadmin` (the docs answer 404 unless a SUPERADMIN session or API token asks) or `public` (development only) |
| `PORT` | default `3001` |
| `INGEST` | `on` (default) or `off`: whether this process consumes the Redis stream |
| `JOBS` | `on` (default) or `off`: whether this process runs background jobs (the camera offline check, every 5 s) |
| `MODELS_DIR` | default `/data/models`: the AI models folder (`inbox/`, `registry/`, built-ins in the root), shared with the engine |
| `MODEL_UPLOAD_MAX_BYTES` | default 1 GiB: the largest ONNX file the web upload accepts |
| `EVIDENCE_DIR` | default `/data/evidence`: kept clips (`<camera>/<date>/<event>.mp4`), written by the pin job |
| `EXPORTS_DIR` | default `/data/exports`: finished PDF reports |
| `GOTENBERG_URL` | optional http(s) URL of Gotenberg; unset: `POST /exports/jobs` answers 503 `UNAVAILABLE` |
| `SNAPSHOT_DIR` | default `/data/snapshots`: where the engine writes event JPEGs; read-only here, served at `/media/snapshots/...` |
| `MEDIAMTX_PLAYBACK_URL` | optional http(s) URL of MediaMTX's playback server; unset: `/media/clips/:eventId` answers `RECORDING_NOT_AVAILABLE` |

The Prisma CLI reads only `DATABASE_MIGRATE_URL` (Postgres as the owner role `zoo_owner`), from
`prisma.config.ts`. The running API never has the owner password.

## Endpoints

All under `/api/v1` unless noted; the roles are in `docs/fe-contract.md`. Every error has the shape
`{statusCode, code, message, errors?}` (`src/common/errors.ts`).

| Area | Endpoints |
|---|---|
| Health (public, `/api/health`) | `GET /health` |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PUT /auth/password` |
| Use cases | `GET /usecases` |
| Cameras | `GET/POST /cameras`, `GET/PATCH/DELETE /cameras/:id` |
| Config | `GET/POST /cameras/:id/config`, `GET /cameras/:id/config/versions[/:version]`, `POST /cameras/:id/config/rollback` |
| Live state | `GET /camera-status`, `GET /cameras/:id/status`, `GET /cameras/:id/frame` |
| Models | `GET/POST /models`, `POST /models/rescan`, `GET/DELETE /models/:id`, `POST /models/:id/validate`, `POST /models/:id/convert` |
| Users, tokens | `GET/POST /users`, `PATCH /users/:id`, `GET/POST /api-tokens`, `DELETE /api-tokens/:id` |
| Reports | `GET /reports/events/stats`, `/reports/intervals/stats`, `/reports/metrics/series` |
| Lists | `GET /events`, `GET /intervals` (cursor paged) |
| CSV | `GET /exports/events.csv`, `intervals.csv`, `metrics.csv`, `summary.csv` (streamed, audited) |
| PDF | `POST /exports/jobs`, `GET /exports/jobs`, `GET /exports/jobs/:id/file` (background jobs, own jobs only) |
| Site settings | `GET /site-settings`, `PATCH /site-settings` (SUPERADMIN): name, time zone, retention days |
| Evidence | `POST /events/:id/evidence` (MANAGER+): keep an event's clip |
| System log (MANAGER+) | `GET /system-log/audit`, `/logins`, `/system-events` and their `.csv` |
| Media (`/media`, outside `/api/v1`) | `GET /media/snapshots/<camera>/<date>/<event>.jpg`, `GET /media/clips/:eventId` |

## Modules

`src/<module>/`, each a Nest module:

| Module | What |
|---|---|
| `auth`, `users`, `api-tokens` | Cookie sessions in Redis, roles, API tokens, `AccessEvents` (who ended whose session) |
| `cameras`, `models`, `usecases` | Cameras and their versioned config, the AI model registry, the use case contracts |
| `engine-internal`, `ingest`, `jobs` | The engine's routes, the Redis stream into Postgres (and `committed$`), the offline check |
| `reports`, `exports`, `system-log` | Aggregates and lists, streamed CSV, audit and login history |
| `media` | Snapshots and clips behind the session |
| `live` | The WebSocket gateway, the status ticker, the push after each ingest commit, audit notices |
| `audit`, `common`, `config`, `contracts`, `openapi`, `demo` | Audit trail, the error filter and codes, env, contract loading, `openapi.json`, the demo feeder |

## Error codes

One body shape, `{statusCode, code, message, errors?}`, from `src/common/errors.ts` (`ERROR_CODES`). Throw with
`apiError(status, code, message, errors?)`. The codes and what the UI does for each are in `docs/fe-contract.md`
section 4.

## WebSocket

socket.io at `/ws`, WebSocket transport only, session cookie only (API tokens are refused), an `Origin` whose host
differs from `Host` is refused. Rooms: `alerts` (everyone), `managers` (MANAGER and SUPERADMIN), `status` (on
request), `user:<id>`. Messages are in `packages/contracts/ws/` and `generated/web/index.d.ts`.

- `status.snapshot` every 2 s while the `status` room has members (`live/status-broadcaster.ts`).
- `event.created` per new event and `data.changed` at most every 5 s, after each ingest commit
  (`ingest/ingest.service.ts` `committed$` to `live/ingest-push.ts`, `live/change-merger.ts`).
- `audit.notice` to `managers` for a change to an `auditCamera` camera (`audit/audit.service.ts` `auditCamera$`).
- `session.ended {reason}` then a disconnect, from `AccessEvents` and the 60 s `recheck()`.

The gateway never touches ingest: every subscriber catches its own errors.

## OpenAPI document

`openapi.json` is generated and committed; CI fails when it is stale.

```
npm run openapi          # writes openapi.json; needs no Postgres or Redis
npm run openapi:check    # regenerates, then fails when the committed file differs
```

Operation ids are `<controller><Method>` (`camerasList`), so the generated hooks read `useCamerasList`. The
script builds the app without `init()`, so no lifecycle hook runs and nothing connects. Response classes live in
`dto/*.dto.ts` files, where the `@nestjs/swagger` build plugin fills each property from its TypeScript type.

## Demo commands

For frontend development without a GPU (profile `demo` in `deploy/`; see `docs/fe-dev-setup.md`):

```
ZOO_DEMO=on DEMO_PASSWORD=... node dist/cli.js demo-seed        # five cameras (engine group demo), three users
node dist/cli.js demo-feed --backfill-days 14                    # plays the engine: history, live, status, frames
```

`demo-seed` refuses unless `ZOO_DEMO=on`, so known-password users cannot appear on a real site by accident, and
refuses a `DEMO_PASSWORD` shorter than 10 characters. It is idempotent: existing users and cameras are skipped.
`demo-feed` reads `REDIS_URL`, `API_URL`, `ENGINE_TOKEN`, `SNAPSHOT_DIR` and `DEMO_SEED` (default 42; its fake
opening hours use `Asia/Jakarta`), writes the history once per Redis volume (key `demo:backfilled`) and stops cleanly on SIGINT.

## Smoke check

`npm run smoke -- http://localhost:8080` checks the stack through Caddy: `/api/health` is 200, the engine's
`/internal/*` paths are 404, and the security headers are set.

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
