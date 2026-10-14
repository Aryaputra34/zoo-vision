# Zoo Vision Phase 3 (Web on the API), Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API serves everything the dashboard needs: one error shape, a generated OpenAPI document, use case
schemas, reports, lists, CSV, snapshots and clips, system log, and live updates over a WebSocket. Caddy puts web,
API, WebSocket and media on one address. A demo feeder lets the FE team run the whole backend without a GPU.
Each step ends in a contract tag the frontend pulls.

**Architecture:** NestJS modules added to `apps/api`: `usecases`, `reports`, `exports`, `media`, `system-log`,
`live` (socket.io gateway at `/ws`) and `demo` (CLI commands). One global error filter shapes every error. The
ingest service announces each committed batch in-process, and the gateway turns it into `event.created` and
`data.changed`. `packages/contracts` gains live status schemas, WebSocket message schemas and a single generated
`generated/web/index.d.ts`. Compose gains Caddy, profiles (`engine`, `web`, `demo`) and port variables.

**Tech Stack:** as in Phase 2 (Node 22, NestJS 11, Prisma 7, ioredis, ajv, Jest + supertest + Testcontainers;
Python 3.12 + uv, pytest), plus `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`,
`socket.io-client` (dev), Caddy 2, and `typescript` as a dev dependency of `packages/contracts`.

**Spec:** `docs/superpowers/specs/2026-10-14-phase-3-web-on-api-design.md` (the Phase 3 design), which refines
`docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`. Conventions come from the
Phase 1 and Phase 2 plans. The frontend half is `zoo-vision-fe/docs/superpowers/plans/2026-10-14-phase-3-web.md`.

## Global Constraints

- Work in `D:\WORK\zoo-vision` on branch `phase-3-web-on-api` (it already holds the design commit). Never commit
  to `main`. Push branches and tags only after the user says yes.
- No Claude attribution: no `Co-Authored-By` trailer, no "Generated with Claude Code" line, in commits or pull
  requests. Put this rule in every implementer prompt.
- The Acer dev laptop (memory `dev-laptop-constraints`):
  - RTX 3050 with 4 GB. The engine runs from source with `uv` on CUDA, at most 3 cameras. Never build the engine
    image.
  - Docker Desktop must be running for Testcontainers and compose; start it before those steps.
  - Host ports 80, 443 (Apache) and 5432 (a local Postgres) are taken: local Caddy uses 8080, and the compose
    Postgres is not published on 5432.
  - Never run `docker compose up` without naming services or setting `COMPOSE_PROFILES` deliberately.
- Don't edit historical documents: `docs/adr/*`, `docs/01_*`, `docs/04_*`, `docs/06_*`,
  `docs/architecture_best_practice_recommendation.md`, the parent spec, the Phase 0–2 plans.
- Versions: use the newest release of each named major when installing, and commit the lockfiles. Image tags stay
  `postgres:17.11-alpine`, `redis:7.4.11-alpine`, `bluenviron/mediamtx:1.21.1`. Pick the current
  `caddy:2.<minor>.<patch>-alpine` tag once and use it exactly.
- Paths: user routes `/api/v1/...`; media `/media/...` (outside the `api` prefix, version-neutral); engine routes
  `/internal/engine/...` (never routed by Caddy, never in Swagger); the WebSocket at `/ws`.
- Contract rules: only add optional fields, new event types and new files. No use case's `schemaVersion` changes.
- Never put these in logs, audit rows, WebSocket messages or responses to anyone below SUPERADMIN: passwords,
  password hashes, API tokens, `ENGINE_TOKEN`, camera stream URLs.
- Times: requests take ISO 8601 with an offset; responses are UTC ISO strings with milliseconds. Buckets and CSV
  times use `SITE_TIMEZONE` (default `Asia/Jakarta`).
- Error bodies: `{statusCode, code, message, errors?}` (Task 1). Every new route throws through `apiError()`.
- Numbers fixed here:

  | What | Value |
  |---|---|
  | `status.snapshot` | every 2 s while the `status` room has members |
  | `data.changed` | first change at once, then at most one merged message per 5 s |
  | `event.created` | one per new event; a commit with more than 50 sends only `data.changed` |
  | WebSocket session recheck | every 60 s |
  | Range limits | `5m` 2 days, `15m` 7 days, `hour` 31 days, `day` 400 days |
  | Lists | `limit` default 100, max 500 |
  | CSV | keyset batches of 5,000 rows |
  | `PUT /auth/password` | 5 per 15 minutes per user |
  | ioredis shared client | `maxRetriesPerRequest: 2`, `commandTimeout: 5000` |
  | Demo feed | status every 5 s (expires 15 s), frame every 2 s (`PX 10000`), one camera silent 2 min every 10 min, opening hours 08:00–17:00 local |

- Contract tags: `contract-v0.1` (Task 9), `contract-v0.2` (Task 14), `contract-v0.3` (Task 16),
  `contract-v0.4` (Task 17). `contract-v1.0` is tagged in the frontend plan's joint acceptance task, when both
  halves are done. Every tag's commit updates `apps/api/openapi.json` and the changelog in `docs/fe-contract.md`.
  Merge the branch with a merge commit, never a squash, so the tagged commits stay in `main`'s history.

## Decisions this plan makes beyond the design

The user should confirm these when reviewing the plan.

1. **`live` gets a contract.** Each use case gets `usecases/<id>/live.schema.json`, describing what its pipeline
   puts in `cam:{id}:status` `live` (today untyped). The FE team needs those field names for live tiles. An engine
   test pins each pipeline's payload to its schema. All fields optional; extra fields allowed.
2. **Operation ids are `<controller><Method>`** (`CamerasController.list` → `camerasList`), so the generated
   hooks read `useCamerasList`, not `useCamerasControllerList`.
3. **`openapi.json` is written without Postgres or Redis.** The script builds the Nest app without `init()` (no
   lifecycle hooks run) and reads the routes. The nest-cli Swagger plugin fills DTO properties from their types.
4. **One `ActorResolver`** (factored out of `AuthGuard`) resolves a cookie or Bearer token to an actor. The auth
   guard, the superadmin-only Swagger check and the WebSocket handshake all use it.
5. **The error filter replaces `TransientDbFilter`** and keeps its logging. ioredis timeouts also become 503
   `UNAVAILABLE`.
6. **Blocking Redis readers** (the events consumer, every subscriber) are duplicates with
   `maxRetriesPerRequest: null` and no `commandTimeout`, so the shared client's 5 s timeout never cuts a `BLOCK`.
7. **Interval stats semantics:** `count` = intervals that start in the bucket; `totalSec` = seconds inside the
   bucket (an interval crossing an edge is split); `avgSec`/`maxSec` = whole durations of the intervals that start
   in the bucket. Open intervals end at `min(now, to)`.
8. **Report rows are sparse:** only non-empty buckets come back. The frontend fills the gaps (its `fillBuckets`).
9. **CSV `data` columns come from the contract:** with a `useCase` or `types` filter, one `data.<field>` column per
   property the matching event schemas declare; without, a single JSON `data` column. Columns are then known
   before the first row is streamed.
10. **Compose profiles:** `engine` (mediamtx, engine), `web`, `demo` (demo-seed, demo-feed). Postgres, Redis,
    api-migrate, api and caddy always run. A park server sets `COMPOSE_PROFILES=engine,web` in `deploy/.env`.
11. **Caddy modes:** `ZOO_CADDY_MODE=dev|internal-tls|custom-tls` imports one site file.
12. **The demo seed runs inside a Nest application context** and creates cameras and users through the real
    services. **The demo feed talks to the API over HTTP with the engine token**, like the engine does.
13. **Demo backfill runs once per Redis volume** (key `demo:backfilled`); its events have no snapshots (14 days of
    JPEGs would be about 1 GB). Live demo events get snapshots.
14. **WebSocket `Origin` check:** a handshake whose `Origin` host differs from its `Host` is refused
    (`FORBIDDEN_ORIGIN`). Another app on the same server and a different port counts as same-site for cookies;
    this stops it from opening a socket with the user's session.
15. **`session.ended` reasons:** `logout`, `revoked` (password change elsewhere), `disabled`, `role_changed`,
    `expired`. On `role_changed` the session stays valid; the frontend reconnects instead of logging out.
16. **`SessionService.isLive(hash)`** checks a session without sliding its expiry, for the 60 s recheck. REST calls
    keep sliding it as before.
17. **`model_validation_failed` is not pushed** over the WebSocket (it doesn't come through ingest). The System
    events page loads it over REST.
18. **The EngineCamera fixture lives in `packages/contracts/fixtures/engine-camera.json`**, read by an API e2e
    test and an engine test.
19. **`contract-v1.0` waits for the frontend.** The FE team may still find contract problems while building pages
    after v0.4, so v1.0 is tagged in the joint acceptance task.
20. **Spec verifications #1, #5 and #6 are checked at the API level here**, and through the UI in the frontend
    plan's joint task, because the zone editor and generic views are FE team work.

## Phase 1 and Phase 2 follow-ups

From memories `phase-1-followups` and `phase-2-followups`:

| Follow-up | Where |
|---|---|
| One error shape before the generated client | Task 1 |
| `trust proxy` for the login throttle and `LoginLog` IP | Task 2 |
| `SWAGGER` off by default | Tasks 3, 6 |
| No raw error text in `/api/health` | Task 2 |
| ioredis `maxRetriesPerRequest` / `commandTimeout` | Task 2 |
| Throttle `changePassword` | Task 2 |
| Post-commit WebSocket push, reports and system-log endpoints | Tasks 10–17 |
| `mask_url` misses XMEye path parameters, `#`/`;` in a query value, a leading space | Task 18 |
| One shared `EngineCamera` fixture for API and engine tests | Task 18 |
| Spec verification #3 (two cameras share one model, GPU memory) | Task 19 |

Still parked, with the reason: the `StreamManager` catch-up runaway (Phase 5 soak; the clips don't trigger it);
ANPR rebuilt synchronously in the worker (when ANPR is switched on); a long ONNX conversion starving workers
(Phase 5 soak); a config change while a worker thread is dead (accepted, applies within 60 s). Kept from Phase 2:
downtime only for cameras with `firstSeenAt`; file sources play in real time.

## Needs the user

1. Docker Desktop running for Testcontainers and compose.
2. Task 6: add the new variables to the git-ignored `deploy/.env` (the step lists them).
3. Tasks 9, 14, 16, 17: approve pushing the branch and each `contract-v0.x` tag; the FE pulls from GitHub.
4. Task 19: watch the laptop run (the real engine on CUDA plus the demo stack) and approve the final push. The pull
   request is opened from the compare link.

## Not in this plan

- Everything in the frontend plan (plumbing, pages, the joint acceptance run, `contract-v1.0`).
- Phase 4 and later: WebRTC and boxes, the debug view, retiring `core/api_server.py`, evidence pinning, retention,
  `ExportJob`/BullMQ, the Exports page and PDF, `SiteSettings`, MediaMTX Control API sync, image publishing.

## Review Focus

1. **A user downloads a year of CSV for all cameras and closes the tab after a second.** Expected: the server
   stops reading batches at once and holds no growing buffer. Test in Task 13.
2. **A dashboard stays open while the API or Redis restarts.** Expected: the client reconnects and refetches; a
   Redis error during a status poll is logged once and the next poll works. Test in Task 15.
3. **A user has two tabs open and logs out in one.** Expected: both sockets of that session end with
   `session.ended`; a password change ends the user's other sessions' sockets but not this one's. Test in Task 15.
4. **A crafted event's `snapshotPath` escapes the snapshot folder** (`../`, absolute, backslashes, a symlink).
   Expected: 404, never a file from outside. Test in Task 14.
5. **A report grouped by a `data` field that some rows lack.** Expected: those rows form a `null` group; nothing is
   dropped and nothing fails. Test in Task 10.

## Target layout at the end of this plan

```
apps/api/src/       + common/ (errors, error filter), openapi/, usecases/, reports/, exports/, media/,
                      system-log/, live/, demo/; auth/actor-resolver.ts, auth/access-events.ts
apps/api/demo/frames/  five synthetic JPEGs
apps/api/openapi.json  generated, committed
packages/contracts/ usecases/<id>/live.schema.json, ws/, fixtures/engine-camera.json, generated/web/index.d.ts
deploy/             caddy/, compose profiles and port variables, .env.demo.example
docs/               fe-contract.md, fe-dev-setup.md
tools/              make_demo_frames.py
```

## Models for subagent-driven execution

Per memory `model-split-and-session-cost`: Sonnet implements every task. Opus reviews security, concurrency and
data-integrity code, and does the final whole-branch review.

| Task | Implementer | Reviewer |
|---|---|---|
| 1 error shape, 10–11 report SQL, 13 CSV streaming, 14 media, 15 gateway, 16 push | Sonnet | Opus |
| all others | Sonnet | Sonnet |

---

### Task 1: API: one error shape

**Files:**
- Create: `apps/api/src/common/errors.ts`, `apps/api/src/common/error.filter.ts`, `error.filter.spec.ts`
- Delete: `apps/api/src/prisma/transient.filter.ts` and its spec (the logic moves into the new filter;
  `prisma/transient.ts` stays)
- Modify: `apps/api/src/app.module.ts` (`APP_FILTER` → `ErrorFilter`), `apps/api/src/bootstrap.ts`
  (`ValidationPipe` `exceptionFactory`), `apps/api/src/auth/login-throttler.guard.ts` (429 body), and every
  `throw new …Exception(` under `apps/api/src`
- Test: create `apps/api/test/errors.e2e-spec.ts`; update existing e2e tests that read `body.fields` or a
  message array

**Interfaces:**
- Produces:
  ```ts
  export type ErrorCode =
    | 'BAD_REQUEST' | 'VALIDATION_FAILED' | 'SETTINGS_INVALID' | 'FIELD_NOT_ALLOWED' | 'RANGE_TOO_LONG'
    | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'ROLE_REQUIRED' | 'FORBIDDEN_ORIGIN'
    | 'NOT_FOUND' | 'RECORDING_NOT_AVAILABLE'
    | 'CONFLICT' | 'STALE_VERSION' | 'USERNAME_TAKEN' | 'LAST_SUPERADMIN' | 'CAMERA_HAS_DATA' | 'MODEL_IN_USE'
    | 'TOO_LARGE' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INTERNAL';
  export type FieldError = { path: string; message: string };
  export type ApiErrorBody = { statusCode: number; code: ErrorCode; message: string; errors?: FieldError[] };
  export function apiError(status: number, code: ErrorCode, message: string, errors?: FieldError[]): HttpException;
  @Catch() export class ErrorFilter implements ExceptionFilter
  ```
- The filter:
  - an `HttpException` whose response already has `code` → sent as is;
  - any other `HttpException` → code from its status (400 `BAD_REQUEST`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`,
    404 `NOT_FOUND`, 409 `CONFLICT`, 413 `TOO_LARGE`, 429 `RATE_LIMITED`), message = its string message or the
    first of an array;
  - `isTransient(err)` → 503 `UNAVAILABLE` "Service temporarily unavailable", logged as `TransientDbFilter` did;
  - anything else → 500 `INTERNAL` "Internal error", logged with the stack; the body never carries error text.
- `ValidationPipe` failures → 400 `VALIDATION_FAILED`, `errors` = one `{path: "/<property path>", message}` per
  constraint.
- The codes the frontend switches on, at their throw sites: settings invalid → `SETTINGS_INVALID` (ajv errors in
  `errors`); fields above the actor's role → `ROLE_REQUIRED` (`errors` = `{path, message: "needs SUPERADMIN"}`,
  replacing today's `fields`); stale `baseVersion` → `STALE_VERSION`; username exists → `USERNAME_TAKEN`; last
  superadmin → `LAST_SUPERADMIN`; camera with data → `CAMERA_HAS_DATA`; model in use → `MODEL_IN_USE`. Every other
  throw site keeps its status default.

- [ ] **Step 1: Write the failing tests**

```ts
// test/errors.e2e-spec.ts
it('an unknown route → 404 {statusCode: 404, code: "NOT_FOUND", message}')
it('POST /users with a 5000-character name → 400 VALIDATION_FAILED, errors[0].path "/name"')
it('saving settings with a 2-point polygon → 400 SETTINGS_INVALID, errors[0].path names the polygon')
it('a MANAGER changing model_id → 403 ROLE_REQUIRED, errors contains {path: "/model_id"}')
it('a stale baseVersion → 409 STALE_VERSION')
it('the 11th login within a minute → 429 RATE_LIMITED')
it('no session → 401 UNAUTHENTICATED')
```

`error.filter.spec.ts`: a transient Prisma error → 503 `UNAVAILABLE` and one log line; a plain `Error('db password
leaked')` → 500 `INTERNAL` whose body doesn't contain "leaked"; an `apiError(409, 'STALE_VERSION', 'x')` keeps its
code.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && npm test -- error.filter && npm run test:e2e -- errors`. Expected: FAIL (no `code`).

- [ ] **Step 3: Implement `errors.ts` and `ErrorFilter`, wire the validation pipe and the throttler, and give
  every throw site its code**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass, after updating the
existing tests that read `fields` or message arrays.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): one error shape with stable codes for every error"
```

---

### Task 2: API: proxy address, health text, Redis timeouts, password throttle

**Files:**
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/health/health.controller.ts`,
  `apps/api/src/redis/redis.module.ts`, `apps/api/src/ingest/events-consumer.service.ts`,
  `apps/api/src/common/error.filter.ts`, `apps/api/src/auth/{auth.controller.ts,auth.module.ts}`; create
  `apps/api/src/auth/password-throttler.guard.ts`
- Test: extend `test/auth.e2e-spec.ts`, `test/health.e2e-spec.ts`, `test/ingest.e2e-spec.ts`; create
  `test/redis-down.e2e-spec.ts`

**Interfaces:**
- `configureApp` sets Express `trust proxy` to `1` (exactly one proxy: Caddy). `req.ip` is then the client's
  address from `X-Forwarded-For`.
- Health: `indicator.down()` with no message, so the body says `{"redis": {"status": "down"}}` and no error text.
- The shared client: `new Redis(url, { maxRetriesPerRequest: 2, commandTimeout: 5000 })`. Blocking readers use
  `redis.duplicate({ maxRetriesPerRequest: null, commandTimeout: undefined })`. Later tasks follow the same rule
  for every subscriber.
- The error filter adds: ioredis `MaxRetriesPerRequestError`, "Command timed out" and "Connection is closed"
  errors → 503 `UNAVAILABLE`.
- `PasswordThrottlerGuard` on `PUT /auth/password`: 5 requests per 15 minutes per actor id → 429 `RATE_LIMITED`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth.e2e-spec.ts
it('a login with X-Forwarded-For: 203.0.113.7 writes LoginLog.ip 203.0.113.7')
it('PUT /auth/password: the 6th attempt within 15 minutes → 429 RATE_LIMITED, even with the right password')
// test/health.e2e-spec.ts: createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' })
it('Redis unreachable → 503 and the body is {"redis": {"status": "down"}, ...} with no "message" key')
// test/redis-down.e2e-spec.ts: createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' })
it('POST /auth/login answers 503 UNAVAILABLE within 7 s')
// test/ingest.e2e-spec.ts
it('the consumer stays connected through 7 idle seconds, then ingests a new entry')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- auth health redis-down ingest`. Expected: FAIL (the IP is the test client's, no throttle,
the message is present, login hangs).

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "fix(api): trust one proxy hop, terse health, Redis timeouts, password change throttle"
```

---

### Task 3: API: response types, operation ids, `openapi.json`, Swagger modes

**Files:**
- Modify: `apps/api/nest-cli.json` (plugin `@nestjs/swagger` with `introspectComments: true`,
  `classValidatorShim: true`), `apps/api/src/bootstrap.ts` (split out `configureRoutes(app)`: prefix + versioning),
  `apps/api/src/config/env.ts` (`SWAGGER: 'off' | 'superadmin' | 'public'`, default `off`),
  `apps/api/src/auth/auth.guard.ts` (uses the resolver), `apps/api/package.json`, `.github/workflows/api.yml`
- Create: `apps/api/src/auth/actor-resolver.ts`, `apps/api/src/openapi/{swagger.ts,swagger.spec.ts,write-openapi.ts,docs-access.ts}`
- Modify: every controller and its DTOs: `@ApiOkResponse` / `@ApiCreatedResponse` / `@ApiNoContentResponse` with
  a response class, `@ApiProduces` for files; enums with `enumName`
- Create: `apps/api/openapi.json` (generated)
- Test: create `test/swagger.e2e-spec.ts`

**Interfaces:**
- `ActorResolver.resolve(req: { headers: IncomingHttpHeaders; cookies?: Record<string, unknown> }): Promise<Actor | null>`:
  the logic `AuthGuard` has today (a bad `Authorization` header → null even beside a valid cookie; an inactive
  user's session is destroyed). Also returns `sessionHash?: string` for cookie actors, for Task 15:
  `resolveWithSession(req): Promise<{ actor: Actor; sessionHash: string | null } | null>`.
- `swagger.ts`:
  ```ts
  export function swaggerConfig(): Omit<OpenAPIObject, 'paths'>   // title, version '1', cookie + bearer auth
  export function createOpenApiDocument(app: INestApplication): OpenAPIObject
  ```
  `operationIdFactory: (controllerKey, methodKey) => lowerFirst(controllerKey.replace(/Controller$/, '')) + upperFirst(methodKey)`.
  `ApiErrorBody` is a registered schema; each operation lists 400/401/403 (and 404/409 where thrown) with it.
- `npm run openapi` = `nest build && node dist/openapi/write-openapi.js`. It builds the app with
  `NestFactory.create(AppModule.forRoot(loadEnv(dummyEnv)), { logger: false })`, **without** `init()`, calls
  `configureRoutes`, writes `apps/api/openapi.json` (2-space JSON, trailing newline), calls `app.close()` and
  exits the process (the dummy Redis client would otherwise keep retrying). It must work with no Postgres or Redis
  running. `npm run openapi:check` = `npm run openapi && git diff --exit-code
  openapi.json`.
- `SWAGGER=superadmin`: an Express middleware in front of `/api/docs` and `/api/docs-json` answers 404 unless
  `ActorResolver` returns a SUPERADMIN (session or token).
- CI `api.yml`: after `npm run build`, `npm run openapi:check`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/openapi/swagger.spec.ts (builds AppModule without init, like the script)
it('every operation has an operationId matching ^[a-z][A-Za-z]+$, all unique, e.g. camerasList and authMe')
it('every operation except 204 and file responses has a 2xx application/json schema')
it('no path starts with /internal')
// test/swagger.e2e-spec.ts
it('SWAGGER=off → GET /api/docs-json 404')
it('SWAGGER=superadmin → 404 anonymous and for a MANAGER session; 200 for a SUPERADMIN session and a SUPERADMIN token')
it('SWAGGER=public → 200 anonymous')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- swagger && npm run test:e2e -- swagger`. Expected: FAIL.

- [ ] **Step 3: Implement the resolver, the Swagger helpers, the script, the docs access and the response types**

- [ ] **Step 4: Generate without databases**

Run, with Docker stopped: `npm run openapi`. Expected: `apps/api/openapi.json` is written, and the process exits 0.

- [ ] **Step 5: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api .github/workflows/api.yml
git commit -m "feat(api): typed responses, readable operation ids, generated openapi.json, superadmin-only docs"
```

---

### Task 4: Contracts: live status, WebSocket messages, `model_validation_failed`, the web types file

**Files:**
- Create: `packages/contracts/usecases/<id>/live.schema.json` for `cashier_presence`, `horse_riding`,
  `restaurant_counter`, `restaurant_table`, `vehicle_gate`, each with `examples/live/{valid,invalid}/*.json`
- Modify: `packages/contracts/common/tables.schema.json` (`$defs.TableLive`)
- Create: `packages/contracts/ws/server/{event.created,data.changed,status.snapshot,audit.notice,session.ended}.schema.json`,
  `packages/contracts/ws/client/{subscribe,unsubscribe}.schema.json`, `packages/contracts/ws/examples/**`
- Modify: `packages/contracts/usecases/system/events.schema.json` (+ `model_validation_failed`) and an example
  message
- Modify: `packages/contracts/scripts/generate.mjs`, `packages/contracts/src/{index.js,index.d.ts}`,
  `packages/contracts/README.md`, `packages/contracts/package.json` (dev dependency `typescript`)
- Test: `packages/contracts/test/{usecases,ws,generate}.test.mjs`; create
  `services/engine/tests/test_live_contract.py`
- Generated: `packages/contracts/generated/**`, `services/engine/contracts/**`

**Interfaces:**
- Live schemas (`type: object`, every field optional, `additionalProperties: true`), from each pipeline's
  `emit_status`:

  | Use case | Fields |
  |---|---|
  | `cashier_presence` | `state` string, `clerkPresent` boolean, `clerkCount` integer ≥ 0, `visitorCount` integer ≥ 0 |
  | `horse_riding` | `activeHorses` integer ≥ 0, `departures` and `returns` integer ≥ 0 or null |
  | `vehicle_gate` | `inCount`, `outCount` integer ≥ 0, `anprEnabled` boolean |
  | `restaurant_counter` | `occupancy`, `rawOccupancy` integer ≥ 0, `maxCapacity`, `warningCapacity` integer, `mode` string, plus the table fields below |
  | `restaurant_table` | `totalTables`, `occupiedTables`, `vacantTables` integer ≥ 0, `occupancyRatePct` number 0–100, `dwellTimeEnabled` boolean, `tables`: `TableLive[]` |

  `TableLive` = `{id, name, status (string), isOccupied, personCount, capacity, dwellSec, trackDwellTime, totalSessions}`.
- WebSocket payloads:
  ```
  event.created   { id, time (date-time), cameraId: string|null, useCase, type, severity: info|warning|critical,
                    data: object, snapshotUrl: string|null }
  data.changed    { cameraIds: string[], useCases: string[], shapes: ("event"|"interval"|"metric")[] }
  status.snapshot { at (date-time), cameras: { [cameraId]: CameraStatus | null } }
                  CameraStatus = { state, fps: number, lastFrameAt: number|null, appliedVersion: integer|null,
                                   configError: string|null, restarts: integer, live: object, updatedAt: number }
  audit.notice    { auditId: string, cameraId, actorName, action, time (date-time) }
  session.ended   { reason: "logout"|"revoked"|"disabled"|"role_changed"|"expired" }
  subscribe, unsubscribe (client → server) { rooms: ["status"] }, minItems 1, enum ["status"]
  ```
- `model_validation_failed` data: `{ modelId (format uuid), name (1–200 chars), error (1–500 chars) }`, all required.
- `generated/web/index.d.ts`, one self-contained file with no imports:
  - the envelope types at top level;
  - `export declare namespace <useCaseId> { … }` per use case: its settings, event, interval and live types
    (namespaces keep each use case's `Point`, `Polygon`… apart);
  - the WebSocket payload types (`EventCreated`, `DataChanged`, `StatusSnapshot`, `CameraStatus`, `AuditNotice`,
    `SessionEnded`, `Subscribe`, `Unsubscribe`);
  - `export interface ServerToClientEvents { 'event.created': (p: EventCreated) => void; … }` and
    `export interface ClientToServerEvents { subscribe: (p: Subscribe, ack: (r: { ok: boolean; code?: string }) => void) => void; unsubscribe: … }`;
  - `export type UseCaseId = 'cashier_presence' | … | 'vehicle_gate'`.
- Schema `title`s name the generated types: `<PascalUseCase>Live` for live schemas (`HorseRidingLive`), and
  `EventCreated`, `DataChanged`, `StatusSnapshot`, `CameraStatus`, `AuditNotice`, `SessionEnded`, `Subscribe`,
  `Unsubscribe` for the WebSocket schemas.
- Pydantic models are generated for `live.schema.json` the way `settings.schema.json` is.
- The WebSocket types are also written to `generated/ts/ws.d.ts` and re-exported from the package index, so the
  API imports the same types (`import type { DataChanged } from '@zoo-vision/contracts'`).
- Validator additions: `UseCaseContract.live: JsonSchema | null`;
  `validateLive(useCase: string, live: unknown): ValidationResult` (`{ok: true}` for a use case without a live
  schema); `validateWsMessage(name: string, payload: unknown): ValidationResult` (an unknown name is an error).

- [ ] **Step 1: Write the failing tests**

```js
// test/usecases.test.mjs
it('every use case with settings has a live schema; live examples pass and invalid ones fail')
it('system accepts a model_validation_failed event; one without error fails')
// test/ws.test.mjs
it('each ws example validates; a status.snapshot with a null camera is valid')
it('validateWsMessage("nope", {}) fails; subscribe {rooms: ["managers"]} fails')
// test/generate.test.mjs
it('generated/web/index.d.ts compiles alone with tsc --noEmit --strict and exports ServerToClientEvents')
```

```python
# services/engine/tests/test_live_contract.py
# For each of the five use cases, run the pipeline on the synthetic detections its existing tests use
# (see tests/test_pipeline_messages.py), then:
def test_live_matches_contract(use_case):
    <UseCase>Live.model_validate(pipeline.live, strict=True)
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/contracts && npm test`; `cd services/engine && uv run pytest tests/test_live_contract.py -q`.
Expected: FAIL.

- [ ] **Step 3: Write the schemas and examples, extend the generator and the validator, regenerate**

Run: `npm run generate`.

- [ ] **Step 4: Run everything**

Run: `cd packages/contracts && npm test && npm run check`; `cd apps/api && npm run build && npm test`;
`cd services/engine && uv run pytest -q && uv run ruff check .`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts services/engine
git commit -m "feat(contracts): live status and WebSocket message schemas, model_validation_failed, one web types file"
```

---

### Task 5: API: `GET /usecases`

**Files:**
- Create: `apps/api/src/usecases/{usecases.module.ts,usecases.controller.ts,dto/usecase.dto.ts}`
- Modify: `apps/api/src/app.module.ts`, `apps/api/openapi.json`
- Test: create `apps/api/test/usecases.e2e-spec.ts`

**Interfaces:**
- Consumes: `ContractsService.registry` (Task 4 adds `live`).
- Produces: `GET /api/v1/usecases`, any role, `UseCaseDto[]` sorted by id:
  ```ts
  UseCaseDto = { id: string; label: string; schemaVersion: number; assignable: boolean;
                 settingsSchema: object | null; liveSchema: object | null;
                 events: { type: string; schema: object }[]; intervals: { kind: string; schema: object }[];
                 metrics: { name: string; label: string; unit: string }[] }
  ```
  `settingsSchema` is the generated, dereferenced schema with its `default`, `x-geometry` and `x-minRole`
  keywords. `operationId` `usecasesList`.

- [ ] **Step 1: Write the failing tests**

```ts
it('as USER returns six use cases sorted by id; system has assignable false and settingsSchema null')
it('horse_riding has a property with x-geometry "line", and model_id with x-minRole "SUPERADMIN"')
it('restaurant_counter lists metric occupancy (unit persons) and interval kind table_session')
it('restaurant_table liveSchema describes tables')
it('no session → 401 UNAUTHENTICATED')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- usecases`. Expected: FAIL (404).

- [ ] **Step 3: Implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): use case registry endpoint for the zone editor and generated forms"
```

---

### Task 6: Deploy: Caddy, port variables, profiles, container names

**Files:**
- Modify: `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/README.md`, `docs/10_LOCAL_QUICKSTART.md`,
  and every doc that names `zoo_postgres`, `zoo_redis`, `zoo_api`, `zoo_mediamtx` or `zoo_vision_service` (grep;
  historical documents excepted)
- Create: `deploy/caddy/Caddyfile`, `deploy/caddy/sites/{dev,internal-tls,custom-tls}.caddy`,
  `deploy/.env.demo.example`, `apps/api/scripts/smoke.ts` (npm script `smoke`)

**Interfaces:**
- Compose:
  - top-level `name: zoo-vision`; no `container_name` anywhere;
  - profiles: `mediamtx`, `zoo-ai-engine` → `engine`; `web` → `web`; `demo-seed`, `demo-feed` (Tasks 7–8) →
    `demo`. `postgres`, `redis`, `api-migrate`, `api`, `caddy` have no profile;
  - `api`: `ports: ["127.0.0.1:${ZOO_API_PORT:-3001}:3001"]`, `COOKIE_SECURE: ${ZOO_COOKIE_SECURE:-true}`,
    `SWAGGER: ${ZOO_SWAGGER:-off}`, `extra_hosts: ["host.docker.internal:host-gateway"]`;
  - `zoo-ai-engine`: `API_URL=http://127.0.0.1:${ZOO_API_PORT:-3001}`;
  - `caddy`: the pinned image; `ports: ["${ZOO_HTTP_PORT:-80}:${ZOO_HTTP_PORT:-80}", "${ZOO_HTTPS_PORT:-443}:${ZOO_HTTPS_PORT:-443}"]`;
    environment `ZOO_HTTP_PORT`, `ZOO_HTTPS_PORT`, `ZOO_SITE_ADDRESS` (default `localhost`), `ZOO_CADDY_MODE`
    (default `internal-tls`), `ZOO_WEB_UPSTREAM` (default `web:3000`); volumes `./caddy:/etc/caddy:ro`,
    `${ZOO_DATA_DIR:-./data}/certs:/certs:ro`, named `caddy_data`, `caddy_config`; `extra_hosts` host-gateway;
    depends on `api` healthy;
  - `web` (profile `web`): `build: ${ZOO_WEB_DIR:-../../zoo-vision-fe}`, image
    `zoo-vision-web:${ZOO_VERSION:-dev}`, healthcheck on `/`.
- `Caddyfile`: global `{ http_port {$ZOO_HTTP_PORT:80}; https_port {$ZOO_HTTPS_PORT:443}; admin off }`, a
  `(zoo_routes)` snippet, and `import sites/{$ZOO_CADDY_MODE:internal-tls}.caddy`. The snippet:
  - `/internal/*` → `respond 404`;
  - `/api/*`, `/media/*`, path `/ws` and `/ws/*` → `reverse_proxy api:3001`;
  - everything else → `reverse_proxy {$ZOO_WEB_UPSTREAM:web:3000}`;
  - headers `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`,
    `Referrer-Policy strict-origin-when-cross-origin`, `-Server`.
- Sites: `dev.caddy` = `http://:{$ZOO_HTTP_PORT:80} { import zoo_routes }`; `internal-tls.caddy` =
  `{$ZOO_SITE_ADDRESS:localhost} { tls internal; import zoo_routes }`; `custom-tls.caddy` = the same with
  `tls /certs/cert.pem /certs/key.pem`.
- `.env.example`: every new variable with a comment, and `COMPOSE_PROFILES=engine,web` for a park server.
  `.env.demo.example`: the FE team's file, with fixed dev-only secrets marked "never on a real site",
  `COMPOSE_PROFILES=demo`, `ZOO_HTTP_PORT=8080`, `ZOO_CADDY_MODE=dev`, `ZOO_COOKIE_SECURE=false`,
  `ZOO_WEB_UPSTREAM=host.docker.internal:3000`, `ZOO_SWAGGER=public`, `ZOO_DEMO=on`, `DEMO_PASSWORD`.
- `npm run smoke -- <baseUrl>` (ts-node, no new dependencies) checks: `GET /api/health` 200 through Caddy;
  `GET /internal/engine/cameras?group=default` 404; the three security headers on `/api/health`. It exits 1 on
  the first failure and prints which check failed. Task 15 adds a WebSocket check.

- [ ] **Step 1: Write the compose changes, the Caddy files, the env examples and the smoke script**

- [ ] **Step 2: Check the rendering**

Run, in `deploy/`: `docker compose config --services` with `COMPOSE_PROFILES=` empty, then with
`COMPOSE_PROFILES=engine,web`. Expected: the first lists `postgres redis api-migrate api caddy`; the second adds
`mediamtx zoo-ai-engine web`. `grep -rn container_name deploy` is empty.

- [ ] **Step 3: The user updates `deploy/.env`**

Add: `ZOO_HTTP_PORT=8080`, `ZOO_CADDY_MODE=dev`, `ZOO_COOKIE_SECURE=false`,
`ZOO_WEB_UPSTREAM=host.docker.internal:3000`, `ZOO_SWAGGER=public`. Leave `COMPOSE_PROFILES` unset on the
laptop.

- [ ] **Step 4: Run the stack through Caddy**

Run, in `deploy/`: `docker compose up -d --build postgres redis api-migrate api caddy`, then
`cd ../apps/api && npm run smoke -- http://localhost:8080`. Expected: the smoke script passes. `/` answers 502
while no `next dev` runs.

- [ ] **Step 5: Docs**

`deploy/README.md`: the ports table, the profiles, the three Caddy modes, and how to install the internal CA's
root certificate on park PCs (`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`).
`docs/10_LOCAL_QUICKSTART.md`: open the dashboard at `http://localhost:8080`. Replace the old container names
(`docker compose exec api …` instead of `docker exec zoo_api …`).

- [ ] **Step 6: Commit**

```bash
git add deploy apps/api/scripts apps/api/package.json docs/10_LOCAL_QUICKSTART.md
git commit -m "feat(deploy): Caddy in front, host ports as variables, compose profiles, no fixed container names"
```

---

### Task 7: API: demo frames and the demo seed

**Files:**
- Create: `tools/make_demo_frames.py`, `apps/api/demo/frames/{cashier_presence,horse_riding,restaurant_counter,restaurant_table,vehicle_gate}.jpg`
- Create: `apps/api/src/demo/{demo-cameras.ts,demo-seed.ts}`
- Modify: `apps/api/src/cli.ts`, `apps/api/Dockerfile` (copy `demo/`), `deploy/docker-compose.yml` (`demo-seed`)
- Test: create `apps/api/src/demo/demo-cli.spec.ts`, `apps/api/test/demo-seed.e2e-spec.ts`

**Interfaces:**
- `tools/make_demo_frames.py` (run with `uv run --project services/engine python tools/make_demo_frames.py`):
  draws, with OpenCV and a fixed layout per use case, a 1280×720 scene of flat shapes and a grid (a desk, lanes,
  tables, an arena), labelled `DEMO`, and writes JPEG quality 80. No footage, no faces.
- ```ts
  export const DEMO_GROUP = 'demo';
  export type DemoCamera = { id: string; name: string; useCase: string; settings: object; recordingPath: string | null };
  export const DEMO_CAMERAS: DemoCamera[];   // ids demo_<useCase>, one per assignable use case
  export const DEMO_USERS: { username: 'demo-superadmin' | 'demo-manager' | 'demo-user'; name: string; role: Role }[];
  export async function seedDemo(app: INestApplicationContext, password: string): Promise<{ cameras: string[]; users: string[] }>;
  ```
  - Settings: each use case's `packages/contracts/usecases/<id>/examples/settings/valid/current_rules.json`.
  - Cameras: `sourceType FILE`, `mainStreamUrl demo/<useCase>.mp4`, `targetFps 5`, `engineGroup demo`, enabled;
    `recordingPath` `demo_vehicle_gate` and `demo_horse_riding` for those two cameras (so their clips answer
    `RECORDING_NOT_AVAILABLE`), null for the others.
  - `demo-superadmin` is created with `createSuperadmin()`. It is then the actor for creating the other two users
    and the cameras through `UsersService` and `CamerasService`.
  - Idempotent: existing usernames and camera ids are skipped, never changed. The return value lists what was
    created.
- CLI: `node dist/cli.js demo-seed` builds `NestFactory.createApplicationContext(AppModule.forRoot(loadEnv({...process.env, INGEST: 'off', JOBS: 'off'})))`.
  It refuses (exit 1, `demo-seed runs only with ZOO_DEMO=on`) unless `ZOO_DEMO=on`, and refuses a
  `DEMO_PASSWORD` shorter than 10 characters. `runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<number>`
  is exported for the test.
- Compose `demo-seed` (profile `demo`): the API image, `restart: "no"`, the API's database, Redis and key
  variables, `ZOO_DEMO`, `DEMO_PASSWORD`, the models volume, depends on `api` healthy.

- [ ] **Step 1: Make the frames**

Run: `uv run --project services/engine python tools/make_demo_frames.py`. Expected: five JPEGs, each under
150 KB.

- [ ] **Step 2: Write the failing tests**

```ts
// src/demo/demo-cli.spec.ts
it('demo-seed without ZOO_DEMO=on exits 1 and touches nothing')
it('demo-seed with a 9-character DEMO_PASSWORD exits 1')
// test/demo-seed.e2e-spec.ts
it('creates five cameras in group demo and three users with their roles; a second run creates nothing')
it('GET /internal/engine/cameras?group=demo lists the five; group default lists none of them')
it('demo-manager can log in with the password')
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- demo-cli && npm run test:e2e -- demo-seed`. Expected: FAIL.

- [ ] **Step 4: Implement**

- [ ] **Step 5: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tools/make_demo_frames.py apps/api deploy/docker-compose.yml
git commit -m "feat(api): demo cameras and users for development without a GPU"
```

---

### Task 8: API: the demo feed

**Files:**
- Create: `apps/api/src/demo/{rng.ts,demo-generators.ts,demo-generators.spec.ts,demo-feed.ts}`
- Modify: `apps/api/src/cli.ts`, `deploy/docker-compose.yml` (`demo-feed`)
- Modify: `apps/api/test/app.ts` (`listenTestApp`)
- Test: create `apps/api/test/demo-feed.e2e-spec.ts`

**Interfaces:**
- Consumes: `EngineCamera` from `GET /internal/engine/cameras?group=demo`; `validateMessage`, `validateLive`
  (Task 4); the frames (Task 7).
- Produces:
  ```ts
  export function mulberry32(seed: number): () => number;
  export type DemoState = { /* per camera: open intervals, pending returns, counters */ };
  export function historyMessages(camera: EngineCamera, from: Date, to: Date, rng: () => number, tz: string): Message[];  // time order, intervals closed inside [from, to)
  export function liveMessages(camera: EngineCamera, now: Date, state: DemoState, rng: () => number, tz: string): Message[];
  export function liveStatusFields(camera: EngineCamera, state: DemoState, bootId: string, now: Date): Record<string, string>;
  export async function runDemoFeed(opts: { redisUrl: string; apiUrl: string; engineToken: string;
    snapshotDir: string | null; framesDir: string; backfillDays: number; seed: number; tz: string;
    signal: AbortSignal }): Promise<void>;
  // export async function listenTestApp(app: INestApplication): Promise<string>   // test/app.ts: listens on port 0, returns the base URL
  ```
- Activity (local time; nothing outside 08:00–17:00):

  | Use case | Events | Intervals | Metrics (each minute) |
  |---|---|---|---|
  | `vehicle_gate` | `vehicle_crossing`, about 1,200 a day; ENTRY peaks 08–10, EXIT peaks 15–17; vehicleType car 70%, motorcycle 15%, bus 10%, truck 5% | | |
  | `horse_riding` | `horse_crossing` DEPARTURE about 25 an hour 09–16, each followed by its RETURN 8–12 min later | | `active_horses` |
  | `cashier_presence` | `cashier_unattended` once an absence passes 60 s; `customer_waiting` about 10 a day, 30–180 s | `desk_unattended` 4–8 a day, 2–15 min | `queue_length` 0–6, `clerk_count` 0–2 |
  | `restaurant_counter` | `capacity_alert` near at ≥ 45, full at ≥ 60, around 12:00–13:30 | | `occupancy` peaking near 55 at 12:00–13:30 |
  | `restaurant_table` | | `table_session` per table, 20–70 min, gaps 5–30 min | `occupied_tables`, `table_occupancy_pct` |

  `data` fields follow the contracts exactly; every message passes `validateMessage`.
- `runDemoFeed`:
  - fetches its cameras with `Authorization: Bearer <engineToken>`, retrying every 2 s until the API answers;
  - sends `engine_started` `{bootId, engineGroup: 'demo'}` first;
  - backfill: when `backfillDays > 0` and the key `demo:backfilled` is missing, XADDs the history of
    [now − N days, now) for every camera (as the engine does: `XADD events MAXLEN ~ 1000000 * msg <json>`), then
    sets the key. History events have `snapshotPath` null;
  - every second: due live messages. A live event gets a snapshot: the camera's frame copied to
    `<snapshotDir>/<cameraId>/<YYYY-MM-DD local>/<eventId>.jpg`;
  - every 5 s: `cam:{id}:status` (the Phase 2 fields, `state running`, `fps 5.0`, `appliedVersion` = the camera's
    version, `engineGroup demo`, `live` passing `validateLive`), expiring 15 s later;
  - every 2 s: `SET cam:{id}:frame <jpeg> PX 10000`;
  - every 10 min the next camera by id sends nothing (no status, frame or messages) for 2 min;
  - `cfg:changed` (a blocking duplicate) → refetch, so `appliedVersion` and `configVersion` follow saves;
  - stops cleanly on `signal` and on SIGINT/SIGTERM.
- CLI: `node dist/cli.js demo-feed [--backfill-days N]` reads `REDIS_URL`, `API_URL`, `ENGINE_TOKEN`,
  `SNAPSHOT_DIR`, `SITE_TIMEZONE`, `DEMO_SEED` (default 42).
- Compose `demo-feed` (profile `demo`): the API image, `command: ["node", "dist/cli.js", "demo-feed", "--backfill-days", "14"]`,
  `API_URL: http://api:3001`, the snapshots folder `${ZOO_DATA_DIR:-./data}/snapshots:/data/snapshots`, depends
  on `demo-seed` completed.

- [ ] **Step 1: Write the failing tests**

```ts
// src/demo/demo-generators.spec.ts
it('one day of history for each demo camera: every message passes validateMessage')
it('the same seed gives identical messages')
it('vehicle_gate: 1,000–1,400 crossings in a day; most ENTRY crossings before 12:00 local')
it('every interval_open has its interval_close later, both inside [from, to)')
it('no message falls outside 08:00–17:00 Asia/Jakarta')
it('liveStatusFields(...).live passes validateLive for each use case')
// test/demo-feed.e2e-spec.ts (INGEST on, seeded demo, listenTestApp)
it('a 1-day backfill lands in Event, Interval and Metric through the ingest; a second run does not backfill again')
it('cam:demo_vehicle_gate:status has appliedVersion = activeVersion, and cam:demo_vehicle_gate:frame exists')
it('a config saved for demo_horse_riding shows in its status appliedVersion within 3 s')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- demo-generators && npm run test:e2e -- demo-feed`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api deploy/docker-compose.yml
git commit -m "feat(api): demo feed that plays the engine's part: history, live messages, status, frames"
```

---

### Task 9: Docs: the frontend contract guide and dev setup; `contract-v0.1`

**Files:**
- Create: `docs/fe-contract.md`, `docs/fe-dev-setup.md`
- Modify: `apps/api/README.md`

**Content:**
- `fe-contract.md` (describes only what this tag contains):
  1. Versions: tags, `contract:pull`, the changelog rule.
  2. One origin: `/api/v1`, `/media`, `/ws` through Caddy. Never call the API from the Next.js server.
  3. Login and roles: `POST /auth/login`, the `zoo_session` cookie, `GET /auth/me`, logout, the role table (parent
     spec section 4), what a 401 and a 403 mean.
  4. Errors: the shape and the code table (code, status, when, what the UI does).
  5. Use cases and the zone editor: `GET /usecases`; `x-geometry` (`polygon`, `line`; arrays of objects holding
     them, such as tables with `id` and `name`); coordinates 0–1; stable ids the UI generates
     (`^[A-Za-z0-9_-]{1,32}$`); `x-minRole`.
  6. Config editing: the camera fields each role may change (the `MANAGER_FIELDS` set in `cameras.service.ts`;
     stream URLs visible only to SUPERADMIN); `baseVersion` and `STALE_VERSION`; rollback; Saved → Applied by
     polling `GET /cameras/:id/status` until the WebSocket arrives in v0.3.
  7. Camera status and frames: `GET /camera-status`, `GET /cameras/:id/frame`; the `live` types per use case.
  8. WebSocket types: present in `web.d.ts` already; the gateway itself comes in v0.3.
  9. Changelog: `v0.1`.
- `fe-dev-setup.md`: prerequisites (Docker Desktop, Node 22, Git); clone both repos side by side; copy
  `deploy/.env.demo.example` to `deploy/.env`; `docker compose up -d --build`; `npm install && npm run dev` in
  the frontend; open `http://localhost:8080` (never `:3000`, where cookies and the WebSocket don't work); the
  demo logins; resetting the demo data (`docker compose down -v` deletes everything); troubleshooting (port in
  use → `ZOO_HTTP_PORT`; `host.docker.internal` on Linux).

- [ ] **Step 1: Write both documents and the API README section** (endpoints, `SWAGGER` modes, `openapi.json`,
  the demo commands)

- [ ] **Step 2: Follow `fe-dev-setup.md` on this laptop, without touching the user's stack**

The user's `deploy/.env` and volumes stay as they are. Stop the user's stack (`docker compose stop`), then run the
guide's steps with a separate project and the demo env file: `docker compose -p zoo-demo-check --env-file
.env.demo.example up -d --build`. Expected: about a minute after start the backfill is ingested
(`GET /api/v1/camera-status` lists five demo cameras online), and `GET http://localhost:8080/api/v1/usecases` with
a `demo-user` session answers 200. Fix the guide wherever a step didn't work as written. Then
`docker compose -p zoo-demo-check down -v` and start the user's stack again.

- [ ] **Step 3: Commit and tag**

```bash
git add docs/fe-contract.md docs/fe-dev-setup.md apps/api/README.md
git commit -m "docs: frontend contract guide and dev setup for contract v0.1"
git tag contract-v0.1
```

- [ ] **Step 4: Ask the user to approve `git push -u origin phase-3-web-on-api` and `git push origin contract-v0.1`**

---

### Task 10: API: report parameters and event stats

**Files:**
- Create: `apps/api/src/reports/{reports.module.ts,reports.controller.ts,report-query.ts,report-query.spec.ts,buckets.ts,fields.ts,fields.spec.ts,event-stats.service.ts,dto/*.ts}`
- Modify: `apps/api/src/config/env.ts` (+ spec), `apps/api/src/app.module.ts`, `deploy/docker-compose.yml`
  (`SITE_TIMEZONE: ${ZOO_SITE_TIMEZONE:-Asia/Jakarta}`), `apps/api/openapi.json`
- Test: create `apps/api/test/helpers/analytics.ts` (inserts `Event`, `Interval`, `Metric` rows directly),
  `apps/api/test/reports-events.e2e-spec.ts`

**Interfaces:**
- `Env.SITE_TIMEZONE: string`: an IANA name accepted by `Intl.DateTimeFormat`, default `Asia/Jakarta`; an
  invalid one is an `EnvError`.
- ```ts
  export type Bucket = '5m' | '15m' | 'hour' | 'day';
  export const MAX_RANGE_MS: Record<Bucket, number>;   // 2, 7, 31, 400 days
  export class RangeQueryDto { from: string; to: string; cameraIds?: string; useCase?: string }  // cameraIds: comma list, at most 50
  export function parseRange(q: RangeQueryDto): { from: Date; to: Date; cameraIds?: string[]; useCase?: string };  // from < to, else VALIDATION_FAILED
  export function assertRange(range: { from: Date; to: Date }, bucket: Bucket): void;  // RANGE_TOO_LONG
  export function bucketStart(bucket: Bucket, tz: string, column: Prisma.Sql): Prisma.Sql;
    // the local wall-clock bucket start converted back to timestamptz:
    // day/hour: date_trunc(unit, col AT TIME ZONE tz) AT TIME ZONE tz
    // 5m/15m:  date_bin(interval, col AT TIME ZONE tz, TIMESTAMP '2000-01-01') AT TIME ZONE tz
  export function allowedDataField(registry: Registry, types: string[], field: string, kind: 'group' | 'number'): boolean;
  ```
- `GET /api/v1/reports/events/stats` (any role; operationId `reportsEventStats`):
  - query: the range, `bucket`, `types?` (comma list), `groupBy?` (comma list of any of `camera`, `type`,
    `severity`, and at most two `data.<field>`), `max?` (a data field name);
  - a `data` field must be declared in at least one requested type's `data` schema, as a string or enum for
    `groupBy`, as a number or integer for `max`; `types` is required when either is used. Otherwise 400
    `FIELD_NOT_ALLOWED`. The field reaches SQL only as a bound parameter (`data->>$n`);
  - `system` events are left out unless `useCase=system` or `types` names a system type;
  - answer `{ bucket, rows: { bucketStart: string; group: Record<string, string | null>; count: number; max?: number | null }[] }`,
    non-empty buckets only. `group` has one key per `groupBy` item, spelled as requested (`camera`, `type`,
    `severity`, `data.direction`); it is `{}` without `groupBy`. Ordered by `bucketStart`, then the group values.

- [ ] **Step 1: Write the failing tests**

```ts
// test/reports-events.e2e-spec.ts (rows seeded with helpers/analytics.ts)
it('horse_crossing grouped by data.direction per hour: the seeded counts for each hour and direction')
it('a crossing at 2026-10-13T23:30:00Z falls in the day bucket 2026-10-13T17:00:00.000Z (Asia/Jakarta)')
it('5m buckets start on local 5-minute boundaries')
it('groupBy=camera,data.vehicleType,data.direction gives one row per camera, bucket, type and direction, keys in group')
it('groupBy=severity counts info, warning and critical events separately')
it('max=waitingSec on customer_waiting returns the largest waitingSec per bucket')
it('rows without the grouped field come back with group["data.<field>"] null')          // Review Focus 5
it('groupBy=data.snapshot, data.nope, three data fields, or data.direction without types → 400 FIELD_NOT_ALLOWED')
it('hour buckets over 32 days → 400 RANGE_TOO_LONG; from ≥ to → 400 VALIDATION_FAILED')
it('system events are absent unless asked for')
it('as USER → 200; without a session → 401')
```

`report-query.spec.ts`: offsets accepted (`+07:00`, `Z`); a date without an offset rejected; 51 camera ids
rejected. `env.spec.ts`: `SITE_TIMEZONE=Mars/Base` is named in the `EnvError`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- report-query env && npm run test:e2e -- reports-events`. Expected: FAIL.

- [ ] **Step 3: Implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api deploy/docker-compose.yml
git commit -m "feat(api): event stats per time bucket in the site timezone, grouped by camera or a declared field"
```

---

### Task 11: API: interval stats and metric series

**Files:**
- Create: `apps/api/src/reports/{interval-stats.service.ts,metric-series.service.ts}`, DTOs
- Modify: `apps/api/src/reports/reports.controller.ts`, `apps/api/openapi.json`
- Test: create `apps/api/test/reports-intervals-metrics.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 10's range, bucket and field helpers.
- `GET /api/v1/reports/intervals/stats` (operationId `reportsIntervalStats`): the range, `bucket`, `kind`
  (required), `groupBy?` = `camera` | `subject` →
  `{ bucket, rows: { bucketStart; cameraId?; subjectId?: string | null; count: number; totalSec: number; avgSec: number | null; maxSec: number | null }[] }`.
  Semantics (decision 7): `count` = intervals starting in the bucket; `totalSec` = seconds inside the bucket;
  `avgSec`/`maxSec` = whole durations of the intervals starting in the bucket; an open interval ends at
  `min(now, to)`. A bucket with only overlap and no start has `count 0` and null `avgSec`/`maxSec`.
- `GET /api/v1/reports/metrics/series` (operationId `reportsMetricSeries`): the range, `bucket`, `name`
  (required), exactly one of `agg` (`avg`|`max`|`min`) or `above` (a number) →
  `{ bucket, rows: { bucketStart; cameraId; value: number }[] }`; with `above`, `value` = minutes with a value
  ≥ `above`. Both or neither → 400 `VALIDATION_FAILED`.

- [ ] **Step 1: Write the failing tests**

```ts
it('an interval 10:50–11:20 local adds 600 s to the 10:00 bucket and 1200 s to the 11:00 bucket; count 1 only at 10:00')
it('an open interval counts up to now; with to in the past, up to to')
it('avgSec and maxSec use whole durations of the intervals that start in the bucket')
it('groupBy=subject separates table ids')
it('camera_offline intervals do not appear in desk_unattended stats')
it('occupancy agg=max per 5m bucket; above=45 counts the minutes at or above 45')
it('agg and above together, or neither → 400 VALIDATION_FAILED')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- reports-intervals-metrics`. Expected: FAIL.

- [ ] **Step 3: Implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): interval stats split at bucket edges and per-bucket metric series"
```

---

### Task 12: API: event and interval lists

**Files:**
- Create: `apps/api/src/reports/{events.controller.ts,intervals.controller.ts,lists.service.ts,cursor.ts,cursor.spec.ts,rows.ts}`
- Modify: `apps/api/src/reports/reports.module.ts`, `apps/api/openapi.json`
- Test: create `apps/api/test/lists.e2e-spec.ts`

**Interfaces:**
- ```ts
  export type EventRow = { id: string; time: string; cameraId: string | null; cameraName: string | null; useCase: string;
    type: string; severity: 'info' | 'warning' | 'critical'; configVersion: number | null; data: object;
    snapshotUrl: string | null; clipUrl: string | null };
  export type IntervalRow = { id: string; cameraId: string; cameraName: string; useCase: string; kind: string;
    subjectId: string | null; start: string; end: string | null; endReason: string | null;
    durationSec: number | null; data: object };
  export type Page<T> = { rows: T[]; nextCursor: string | null };
  export function encodeCursor(c: { t: string; id: string }): string;   // base64url JSON
  export function decodeCursor(s: string): { t: string; id: string };   // VALIDATION_FAILED when malformed
  export type EventWithCamera = Event & { camera: { name: string; recordingPath: string | null; recordingEnabled: boolean } | null };
  export function eventRow(e: EventWithCamera): EventRow;               // used again by Tasks 16 and 17
  ```
  `snapshotUrl` = `/media/snapshots/` + each `snapshotPath` segment `encodeURIComponent`'d, or null. `clipUrl` =
  `/media/clips/<eventId>` when the camera has a `recordingPath` and `recordingEnabled`, else null.
- `GET /api/v1/events` (operationId `eventsList`): the range, `types?`, `severity?` (comma list), `where?`,
  `cursor?`, `limit?` → `Page<EventRow>`, ordered by `time` desc, `id` desc. `where` is a comma list of at most two
  `data.<field>:<value>` equality filters; each field must pass `allowedDataField(…, 'group')` for the requested
  `types` (so `types` is required), else 400 `FIELD_NOT_ALLOWED`. Field and value are bound parameters. The CSV
  export (Task 13) takes the same `where`.
- `GET /api/v1/intervals` (operationId `intervalsList`): the range (on `start`), `kind?`, `cursor?`, `limit?` →
  `Page<IntervalRow>`, ordered by `start` desc, `id` desc. `durationSec` is null while open.

- [ ] **Step 1: Write the failing tests**

```ts
it('newest first; limit 2 then nextCursor gives the next 2, with no overlap and no gap even when newer rows arrive in between')
it('severity=warning,critical filters; types filters')
it('where=data.direction:ENTRY,data.vehicleType:bus returns only those crossings; where on an undeclared field or without types → 400 FIELD_NOT_ALLOWED')
it('snapshotUrl encodes every path segment; null without a snapshotPath')
it('clipUrl only for cameras with a recordingPath and recording on')
it('limit 501 → 400 VALIDATION_FAILED; a tampered cursor → 400 VALIDATION_FAILED')
it('an open interval has end null and durationSec null')
```

`cursor.spec.ts`: round trip; garbage, wrong JSON shape and a bad date rejected.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- cursor && npm run test:e2e -- lists`. Expected: FAIL.

- [ ] **Step 3: Implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): paged event and interval lists with snapshot and clip URLs"
```

---

### Task 13: API: CSV exports

**Files:**
- Create: `apps/api/src/exports/{exports.module.ts,exports.controller.ts,csv.ts,csv.spec.ts,csv-columns.ts,csv-columns.spec.ts}`
- Modify: `apps/api/src/app.module.ts`, `apps/api/openapi.json`
- Test: create `apps/api/test/exports.e2e-spec.ts`

**Interfaces:**
- ```ts
  export function csvLine(values: unknown[]): string;   // RFC 4180 quoting, CRLF
  export async function streamCsv(res: Response, header: string[], batches: AsyncIterable<unknown[][]>, signal: AbortSignal): Promise<void>;
    // writes the BOM and the header, awaits 'drain' on backpressure, stops when signal aborts
  export function eventColumns(registry: Registry, useCase?: string, types?: string[]): string[];
  ```
- Routes (any role; list filters without `cursor`/`limit`):

  | Route | operationId | Columns |
  |---|---|---|
  | `GET /api/v1/exports/events.csv` | `exportsEvents` | `time_local, event_id, camera_id, camera_name, use_case, type, severity, config_version`, then `data.<field>` per property declared by the filtered event schemas (sorted), or one JSON `data` column without a `useCase`/`types` filter, then `snapshot_url` |
  | `GET /api/v1/exports/intervals.csv` | `exportsIntervals` | `start_local, end_local, duration_sec, interval_id, camera_id, camera_name, use_case, kind, subject_id, end_reason, data` |
  | `GET /api/v1/exports/metrics.csv` | `exportsMetrics` | `minute_local, camera_id, camera_name, use_case, name, value` |
  | `GET /api/v1/exports/summary.csv` (+ `bucket=hour\|day`, range limits) | `exportsSummary` | `bucket_local, camera_id, camera_name, use_case`, then `events.<type>.count`, `intervals.<kind>.total_sec`, `metrics.<name>.avg`, `metrics.<name>.max` for the filtered use cases (sorted) |

- `Content-Type: text/csv; charset=utf-8`; `Content-Disposition: attachment; filename="<kind>-<from local date>-<to local date>.csv"`.
  Local times are `YYYY-MM-DD HH:mm:ss` in `SITE_TIMEZONE`. Rows come in keyset batches of 5,000.
- Each export writes one `AuditLog` row through `AuditService.record` (the interceptor skips GETs): action
  `export.csv`, entity `export`, `after: { kind, filters }`.

- [ ] **Step 1: Write the failing tests**

```ts
// csv.spec.ts
it('quotes a comma, a quote and a newline; leaves plain values bare')
// test/exports.e2e-spec.ts
it('events.csv starts with the BOM and the header; lines end in CRLF')
it('horse_riding events.csv has data.direction and data.trackerId columns')
it('2026-10-13T23:30:00Z is written as 2026-10-14 06:30:00')
it('200,000 seeded metric rows stream while the API heap grows less than 50 MB')
it('a client that aborts after the first chunk stops the batch reads')     // Review Focus 1: count the batch queries
it('each export writes one audit row with its filters')
it('summary.csv per day for 2 cameras: the seeded counts and totals')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- csv && npm run test:e2e -- exports`. Expected: FAIL.

- [ ] **Step 3: Implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): streamed CSV exports of events, intervals, metrics and summaries, audited"
```

---

### Task 14: API: snapshots and clips; `contract-v0.2`

**Files:**
- Create: `apps/api/src/media/{media.module.ts,media.controller.ts,snapshot-path.ts,snapshot-path.spec.ts,clips.service.ts}`
- Modify: `apps/api/src/config/env.ts` (`SNAPSHOT_DIR` default `/data/snapshots`; `MEDIAMTX_PLAYBACK_URL`
  optional http(s) URL), `apps/api/src/bootstrap.ts` (prefix excludes `media/{*path}`),
  `deploy/docker-compose.yml` (api: `SNAPSHOT_DIR`, the snapshots folder read-only,
  `MEDIAMTX_PLAYBACK_URL: ${ZOO_MEDIAMTX_PLAYBACK_URL:-http://host.docker.internal:9996}`),
  `deploy/.env.example`, `apps/api/openapi.json`, `docs/fe-contract.md`
- Test: create `apps/api/test/media.e2e-spec.ts` (with a fake playback server on a free port)

**Interfaces:**
- `@Controller({ path: 'media', version: VERSION_NEUTRAL })`, outside the `api` prefix:
  - `GET /media/snapshots/*path` (operationId `mediaSnapshot`), any role → `image/jpeg`,
    `Cache-Control: private, max-age=86400`; 404 `NOT_FOUND` when missing or refused;
  - `GET /media/clips/:eventId` (operationId `mediaClip`), any role → `video/mp4` streamed from
    `${MEDIAMTX_PLAYBACK_URL}/get?path=<recordingPath>&start=<event time − clipBeforeSec, ISO>&duration=<before + after>&format=mp4`.
    `Cache-Control: no-store` while `time + clipAfterSec` is in the future, else `private, max-age=3600`. The
    upstream request is aborted when the client goes away. 404 `RECORDING_NOT_AVAILABLE` when the variable is
    unset, the event or camera has no `recordingPath`, recording is off, or playback answers non-2xx or is
    unreachable.
- `resolveSnapshot(root: string, rel: string): Promise<string | null>`: null for an absolute path, `..`, a
  backslash, NUL, or a real path (symlinks resolved) outside `root`.

- [ ] **Step 1: Write the failing tests**

```ts
// snapshot-path.spec.ts                                                     // Review Focus 4
it.each(['../x.jpg', '/etc/passwd', 'a/../../x.jpg', 'a\\..\\x.jpg', 'a\u0000.jpg'])('refuses %s')
it('refuses a symlink inside the folder that points outside it')
// test/media.e2e-spec.ts
it('serves a snapshot to a USER session as image/jpeg; 401 without a session')
it('asks playback for start = time − clipBeforeSec and duration = before + after, and streams the MP4')
it('no-store for an event whose clip end is in the future')
it('RECORDING_NOT_AVAILABLE when the URL is unset, the camera has no recordingPath, or playback answers 404')
it('/api/v1/media/snapshots/x is 404')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- snapshot-path && npm run test:e2e -- media`. Expected: FAIL.

- [ ] **Step 3: Implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Update `docs/fe-contract.md` for v0.2**

New sections: reports (parameters, buckets in the site timezone, sparse rows and `fillBuckets`, the interval
semantics of decision 7, `FIELD_NOT_ALLOWED`, `RANGE_TOO_LONG`, the Pony Rides, Cashier and Restaurant example
calls from the design); lists and cursors; CSV (columns, local times, audit); media URLs and
`RECORDING_NOT_AVAILABLE`. Changelog `v0.2`.

- [ ] **Step 6: Commit and tag**

```bash
git add apps/api deploy docs/fe-contract.md
git commit -m "feat(api): snapshots and clips behind the session; contract v0.2"
git tag contract-v0.2
```

- [ ] **Step 7: Ask the user to approve `git push && git push origin contract-v0.2`**

---

### Task 15: API: the WebSocket gateway

**Files:**
- Install: `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`; dev `socket.io-client`
- Create: `apps/api/src/auth/access-events.ts`, `apps/api/src/live/{live.module.ts,live.gateway.ts,handshake.ts,handshake.spec.ts,status-broadcaster.ts}`
- Modify: `apps/api/src/auth/{session.service.ts,auth.service.ts,auth.module.ts}`, `apps/api/src/users/users.service.ts`,
  `apps/api/src/app.module.ts`, `apps/api/scripts/smoke.ts` (WebSocket check), `apps/api/test/app.ts`
- Test: create `apps/api/test/live.e2e-spec.ts`

**Interfaces:**
- Consumes: `ActorResolver.resolveWithSession` (Task 3), `CameraStatusService.read` (Phase 2),
  `validateWsMessage` (Task 4).
- ```ts
  export type AccessEnded = { userId: string; reason: 'logout' | 'revoked' | 'disabled' | 'role_changed';
                              sessionHash?: string; keepSessionHash?: string };
  @Injectable() export class AccessEvents { readonly ended$ = new Subject<AccessEnded>() }
  ```
  - `SessionService.destroy(token)` emits `{userId, sessionHash, reason: 'logout'}`;
  - `revokeAllForUser(userId, exceptToken?)` emits `{userId, keepSessionHash, reason: 'revoked'}`;
  - `UsersService.update` emits `{userId, reason: 'disabled'}` when `active` becomes false, and
    `{userId, reason: 'role_changed'}` when the role changes;
  - `SessionService.isLive(hash: string): Promise<boolean>`: the session exists and is within its 7 days; no
    sliding.
- `@WebSocketGateway({ path: '/ws', transports: ['websocket'], serveClient: false })`:
  - handshake middleware (`handshake.ts`, `authorizeHandshake(req, resolver): Promise<SocketUser | { error: 'UNAUTHENTICATED' | 'FORBIDDEN_ORIGIN' }>`):
    an `Origin` header whose host differs from `Host` → `FORBIDDEN_ORIGIN`; only a cookie session is accepted (no
    Bearer); otherwise `UNAUTHENTICATED`. Refusal = `next(new Error(code))`;
  - `socket.data = { userId, name, role, sessionHash }`; joins `alerts`, `user:<userId>`, and `managers` for
    MANAGER and SUPERADMIN;
  - `subscribe` / `unsubscribe` `{rooms}` with an ack `{ok: true}` or `{ok: false, code: 'VALIDATION_FAILED'}`;
    only `status` may be named;
  - `AccessEvents.ended$` → for each matching socket (`user:<id>` room, filtered by `sessionHash` /
    `keepSessionHash`): emit `session.ended {reason}`, then `disconnect(true)`;
  - every 60 s (`recheck(): Promise<void>`, public for tests): sockets whose `isLive(sessionHash)` is false get
    `session.ended {reason: 'expired'}` and are disconnected;
  - `toAlerts(name, payload)`, `toManagers(name, payload)` for Tasks 16 and 17.
- `StatusBroadcaster`: every 2 s, when the `status` room has members, reads every camera id (cached 10 s) and
  `CameraStatusService.read`, and emits `status.snapshot {at, cameras}`. A Redis error skips that tick and is
  logged at most once a minute.
- Tests connect through `listenTestApp` (Task 8).
- Smoke: log in as `demo-user` (password from `DEMO_PASSWORD`) through Caddy, connect a socket.io client to
  `<base>/ws`, subscribe to `status`, and expect a `status.snapshot` within 5 s.

- [ ] **Step 1: Write the failing tests**

```ts
// handshake.spec.ts
it('Origin http://evil.test with Host localhost:8080 → FORBIDDEN_ORIGIN; same host or no Origin → allowed')
// test/live.e2e-spec.ts (listenTestApp; socket.io-client with a Cookie header)
it('no cookie, a dead session, or only a Bearer token → connect_error UNAUTHENTICATED')
it('a USER joins alerts but not managers; a MANAGER joins both')
it('subscribe status → status.snapshot within 3 s listing every camera; one with a status hash is parsed, the others null')
it('subscribe {rooms: ["managers"]} → ack {ok: false, code: "VALIDATION_FAILED"}')
it('logging out in one tab ends both sockets of that session with session.ended logout')      // Review Focus 3
it("changing the password ends the user's other sessions' sockets, not this session's")       // Review Focus 3
it('disabling the user → session.ended disabled; changing the role → session.ended role_changed')
it('recheck() ends a socket whose session has expired, with reason expired')
it('a Redis error during a status tick is logged once and the next tick sends a snapshot')   // Review Focus 2
it('every message the gateway sends validates with validateWsMessage')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- handshake && npm run test:e2e -- live`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run everything, then the smoke script through Caddy**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`; rebuild `api` in compose and run
`npm run smoke -- http://localhost:8080`. Expected: all pass, including the WebSocket check.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): WebSocket gateway at /ws with session auth, rooms, status snapshots and access changes"
```

---

### Task 16: API: post-commit push; `contract-v0.3`

**Files:**
- Modify: `apps/api/src/ingest/ingest.service.ts`, `apps/api/src/live/live.module.ts`
- Create: `apps/api/src/live/{change-merger.ts,change-merger.spec.ts,ingest-push.ts}`
- Modify: `docs/fe-contract.md`
- Test: create `apps/api/test/live-push.e2e-spec.ts`

**Interfaces:**
- ```ts
  export type IngestCommit = { events: EventMessage[]; cameraIds: string[]; useCases: string[];
                               shapes: ('event' | 'interval' | 'metric')[] };
  IngestService.committed$: Subject<IngestCommit>
  ```
  Emitted after the XACK of every applied transaction (batch or one-by-one) that wrote at least one row. `events`
  holds only newly inserted events (`inserted === 1`); interval opens and closes and metric upserts count as
  writes for `shapes`. A failed transaction emits nothing.
- `class ChangeMerger { constructor(windowMs: number, emit: (c: DataChanged) => void); add(c: DataChanged): void; close(): void }`:
  the first change after a quiet window is emitted at once; later ones within the window are merged (set unions)
  and emitted once at its end.
- `IngestPush` subscribes to `committed$`: at most 50 new events → one `event.created` each (built with
  `eventRow`), to `alerts`; every commit → `ChangeMerger.add`, which sends `data.changed` to `alerts`. Any error is
  logged and swallowed, so ingest never notices.

- [ ] **Step 1: Write the failing tests**

```ts
// change-merger.spec.ts (fake timers)
it('the first change is sent at once; three more within 5 s are sent as one merged message at 5 s')
it('a change after a quiet window is sent at once again')
// test/live-push.e2e-spec.ts (INGEST on, a socket in alerts)
it('an XADDed event → event.created with snapshotUrl, and the row already exists when it arrives')
it('one commit with 60 new events → no event.created and one data.changed')
it('a redelivered, already stored event → no event.created')
it('a transaction that fails (database down) pushes nothing')
it('a gateway error does not stop ingest: the next entry is still written')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- change-merger && npm run test:e2e -- live-push`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 5: Update `docs/fe-contract.md` for v0.3**

The WebSocket section: connecting (`io({path: '/ws', transports: ['websocket']})`, typed with
`ServerToClientEvents`), the rooms, every message, the 5 s rule, `session.ended` reasons and what the UI does for
each (`role_changed` → refetch `/auth/me` and reconnect; the others → login), "live data paused" after 10 s
without `status.snapshot`, refetch after every reconnect. Changelog `v0.3`.

- [ ] **Step 6: Commit and tag**

```bash
git add apps/api docs/fe-contract.md
git commit -m "feat(api): push new events and data changes after each ingest commit; contract v0.3"
git tag contract-v0.3
```

- [ ] **Step 7: Ask the user to approve `git push && git push origin contract-v0.3`**

---

### Task 17: API: system log, audit cameras, `model_validation_failed`; `contract-v0.4`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`AuditLog.auditCamera Boolean @default(false)`); create migration
  `<ts>_audit_camera`
- Modify: `apps/api/src/audit/{audit-context.ts,audit.service.ts,audit.interceptor.ts}`,
  `apps/api/src/cameras/{cameras.controller.ts,camera-config.controller.ts}`,
  `apps/api/src/models/models.service.ts`, `apps/api/src/live/live.module.ts`
- Create: `apps/api/src/system-log/{system-log.module.ts,system-log.controller.ts,system-log.service.ts}`
- Modify: `apps/api/openapi.json`, `docs/fe-contract.md`
- Test: create `apps/api/test/system-log.e2e-spec.ts`

**Interfaces:**
- `AuditEntry.auditCamera?: boolean`. `PATCH /cameras/:id`, `DELETE /cameras/:id`, config save and rollback set it
  when the camera's `auditCamera` is true before or after the change.
- `AuditService.record(entry): Promise<{ id: bigint }>`;
  `AuditService.auditCamera$: Subject<{ auditId: string; cameraId: string; actorName: string; action: string; time: string }>`,
  emitted after a flagged row is written. `LiveModule` forwards it as `audit.notice` to `managers`.
- Routes (MANAGER and up; newest first; cursor = the row id for audit and logins, Task 12's cursor for events):

  | Route | operationId | Filters | Rows |
  |---|---|---|---|
  | `GET /api/v1/system-log/audit` | `systemLogAudit` | range, `actor?`, `entity?`, `action?`, `auditCamera?` | `{id: string, time, actorType, actorName, action, entity, entityId, before, after, ip, auditCamera}` |
  | `GET /api/v1/system-log/logins` | `systemLogLogins` | range, `username?`, `result?` | `{id: string, time, username, userId, result, ip, userAgent}` |
  | `GET /api/v1/system-log/system-events` | `systemLogSystemEvents` | range, `types?` | `EventRow` with `useCase system` |
  | `…/audit.csv`, `…/logins.csv`, `…/system-events.csv` | `systemLogAuditCsv`, … | the same | Task 13's `streamCsv`; each export audited |

- `ModelsService.reportValidation`, when a model becomes `FAILED`, inserts an `Event`: id `evt_<32 hex>`, time now,
  `cameraId` null, `useCase system`, `type model_validation_failed`, severity `warning`, `configVersion` null, the
  system contract's `schemaVersion`, `data {modelId, name, error}`.

- [ ] **Step 1: Write the failing tests**

```ts
it('USER → 403 on every system-log route; MANAGER → 200')
it('a config save on an auditCamera camera writes auditCamera true and sends audit.notice to a MANAGER socket, never to a USER socket')
it('auditCamera=true filters; paging by id stays stable')
it('logins lists WRONG_PASSWORD and SUCCESS rows for a username')
it('a FAILED validation report adds one model_validation_failed system event; a READY one adds none')
it('system-events.csv contains the system events, and the export is audited')
it('the append-only grants still hold for AuditLog (append-only e2e passes unchanged)')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:e2e -- system-log`. Expected: FAIL.

- [ ] **Step 3: Write the migration, then implement, then `npm run openapi`**

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e && npm run openapi:check`. Expected: all pass.

- [ ] **Step 5: Update `docs/fe-contract.md` for v0.4** (the system log routes, audit cameras, `audit.notice`,
  `model_validation_failed`; changelog `v0.4`)

- [ ] **Step 6: Commit and tag**

```bash
git add apps/api docs/fe-contract.md
git commit -m "feat(api): system log views, audit camera flag and notices, model_validation_failed; contract v0.4"
git tag contract-v0.4
```

- [ ] **Step 7: Ask the user to approve `git push && git push origin contract-v0.4`**

---

### Task 18: Engine and API: `mask_url` gaps, the shared EngineCamera fixture

**Files:**
- Modify: `services/engine/core/stream_manager.py`, `services/engine/tests/test_stream_manager.py`
- Create: `packages/contracts/fixtures/engine-camera.json`, `services/engine/tests/test_engine_camera_fixture.py`
- Modify: `apps/api/test/engine-internal.e2e-spec.ts`; `.github/workflows/{api.yml,engine.yml}` path filters
  (+ `packages/contracts/fixtures/**`)

**Interfaces:**
- `mask_url` rules added (fail closed; the existing cases keep their results):
  - leading whitespace is kept and ignored for the scheme check;
  - a secret-named parameter after `?`, `&` or `;` is masked up to the next `&` (no longer stopping at `#` or `;`);
  - a secret-named parameter in the path, after `/` or `_`, masks everything after its `=` to the end.
- The fixture: `{ "camera": <POST /cameras body>, "settings": <config body settings>, "engineCamera": <the expected /internal/engine/cameras entry> }`,
  a `vehicle_gate` camera with a sub stream, `inferenceStream SUB`, `imgsz [384, 640]` and an `nxCameraId`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_stream_manager.py, new cases
("rtsp://10.0.0.5:554/user=admin_password=Secr3t_channel=1_stream=0.sdp", "rtsp://10.0.0.5:554/user=admin_password=***"),
("rtsp://10.0.0.5/live?password=ab#cd&channel=1", "rtsp://10.0.0.5/live?password=***&channel=1"),
("rtsp://10.0.0.5/live?password=ab;cd&channel=1", "rtsp://10.0.0.5/live?password=***&channel=1"),
(" rtsp://admin:pw@10.0.0.5/s", " rtsp://***@10.0.0.5/s"),
("\trtsp://admin:pw@10.0.0.5/s", "\trtsp://***@10.0.0.5/s"),
# tests/test_engine_camera_fixture.py
def test_engine_parses_the_shared_fixture():   # CameraConfig.from_api(fixture["engineCamera"]) → id, use_case, source_url, target_fps, model_path, imgsz (384, 640), nx_camera_id
```

```ts
// test/engine-internal.e2e-spec.ts
it('the snapshot entry for the fixture camera deep-equals fixture.engineCamera')
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd services/engine && uv run pytest tests/test_stream_manager.py tests/test_engine_camera_fixture.py -q`;
`cd apps/api && npm run test:e2e -- engine-internal`. Expected: FAIL.

- [ ] **Step 3: Implement the masking rules and write the fixture**

- [ ] **Step 4: Run everything**

Run: `cd services/engine && uv run pytest -q && uv run ruff check .`; `cd apps/api && npm run test:e2e`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/engine packages/contracts/fixtures apps/api/test .github/workflows
git commit -m "fix(engine): mask XMEye path credentials, #/; in secret values, leading spaces; shared EngineCamera fixture"
```

---

### Task 19: Docs and the laptop run

**Files:**
- Modify: `deploy/README.md`, `docs/10_LOCAL_QUICKSTART.md`, `apps/api/README.md`, `services/engine/README.md`
  (the `live` contract)

**Docs content:**
- `deploy/README.md`: every environment variable added in this phase, the profiles, Caddy, the demo stack, and
  that `COMPOSE_PROFILES=engine,web` runs a park server.
- `docs/10_LOCAL_QUICKSTART.md`: the laptop run behind Caddy on 8080, the demo stack next to a real engine, and
  the engine variables (`API_URL` with `ZOO_API_PORT`).
- `apps/api/README.md`: the module list, the error codes, `openapi.json`, the WebSocket.

- [ ] **Step 1: Update the docs**

- [ ] **Step 2: Start the stack**

In `deploy/` (the user's `.env`, plus `ZOO_DEMO=on` and `DEMO_PASSWORD`; the demo cameras and users then stay in
this laptop's database, in group `demo`):
`docker compose --profile demo up -d --build postgres redis api-migrate api caddy demo-seed demo-feed`. Then start
the engine from source on CUDA (`ENGINE_GROUP=default`, `DEVICE=cuda:0`, `API_URL=http://127.0.0.1:3001`) with two
`FILE` cameras in group `default` on the same model `yolo26s.onnx`, imgsz 640, 5 fps:
- the gate: `D:/WORK/video_demo/vlc-record-2026-10-02-19h48m37s-gateway_kendaraan.mp4-.mp4` (memory
  `gate-test-clip`);
- the ponies: `D:/WORK/video_demo/vlc-record-2026-09-30-14h55m15s-horse_riding.mp4-.mp4`.

- [ ] **Step 3: The checks** (with the user watching; API-level, the UI checks are in the frontend plan's joint
  task)

| # | Do | Expected |
|---|---|---|
| a (#1) | save the gate config with the tripwire moved | a socket subscribed to `status` sees `appliedVersion` follow within ~1 s; no "Connecting to stream" in the engine log; gate crossings keep arriving as `event.created` |
| b (#1) | save a polygon with two points | 400 `SETTINGS_INVALID`; the engine keeps the previous version |
| c (#3) | `nvidia-smi` with both cameras running, then with one | one loaded model instance: GPU memory doesn't grow by a second model's size |
| d (#5) | on a scratch branch, add a contract-only use case `dummy` with one event type and one metric, regenerate, rebuild the API, XADD a few `dummy` messages by hand | they are in `GET /events`, `GET /reports/events/stats` and `GET /reports/metrics/series` with no API code change. Then delete the scratch branch |
| e (#6) | as `demo-user`: `POST /cameras/:id/config` → 403; as `demo-manager`: change `model_id` → 403 `ROLE_REQUIRED`; disable `demo-user` while its socket is open | the socket gets `session.ended disabled`, its next REST call is 401 |
| f (#6) | `/api/docs` with `ZOO_SWAGGER=superadmin`: as `demo-superadmin` session and as a SUPERADMIN API token, and as `demo-manager` | 200, 200, 404 |
| g (#6) | three wrong passwords for `demo-user`, then `GET /system-log/logins` | three `WRONG_PASSWORD` rows with this laptop's address, not Caddy's |
| h (#9) | `GET /exports/events.csv` for three demo cameras over seven days | opens in Excel with correct accents and local times; the export is in `GET /system-log/audit` |
| i (#10) | stop the engine's gate camera (disable it) or wait for the demo feed's 2-minute silence | offline within ~15 s; a `camera_offline` interval in `GET /intervals?useCase=system&kind=camera_offline`; the other cameras unaffected |
| j | `npm run smoke -- http://localhost:8080` | passes |

- [ ] **Step 4: Run every suite**

Run: `cd packages/contracts && npm test && npm run check`; `cd apps/api && npm run lint && npm run build &&
npm test && npm run test:e2e && npm run openapi:check`; `cd services/engine && uv run pytest -q && uv run ruff
check .`. Expected: all pass.

- [ ] **Step 5: Commit, then ask before pushing**

```bash
git add deploy docs/10_LOCAL_QUICKSTART.md apps/api/README.md services/engine/README.md
git commit -m "docs(deploy): Phase 3 Caddy, profiles, demo stack and the laptop run"
```

Ask the user to approve `git push`. After the push, give the compare link for the pull request. Merge with a merge
commit (not squash), so the contract tags stay in `main`'s history. `contract-v1.0` comes later, in the frontend
plan's joint acceptance task.
