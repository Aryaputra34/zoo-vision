# Zoo Vision Phase 3: the web on the API (design)

- **Status:** agreed section by section on 2026-10-14, awaiting review
- **Date:** 2026-10-14
- **Parent spec:** `docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`, section 6
  (phase 3) and the sections it points to: 3 (event flow step 4), 4 (API modules, edge, frontend contract),
  7 (menus, system log, exports), 8 (tests). This document adds Phase 3 detail and records where it departs
  from the parent spec ("Changes to the parent spec" below). The parent spec stays as written.
- **Readers:** the backend developer (the project lead) and the frontend team. Sections 1, 5 and the contract
  parts of 2–4 are what the frontend builds against.

## Goal

The dashboard (`zoo-vision-fe`) runs entirely on the NestJS API. It no longer reads a database, proxies the
engine or keeps its own login. Pages get their numbers from report endpoints, update live over a WebSocket,
and the Config menu edits cameras, zones, models, users and API tokens through the API. Everything sits behind
Caddy on one address.

## Decisions taken in the 2026-10-14 brainstorm

| # | Question | Decision |
|---|---|---|
| 1 | Who calls the API: the browser or the Next.js server? | **The browser**, through Caddy, with the session cookie. The Next.js server never calls the API and needs no backend address or secret. |
| 2 | How specific are the report endpoints? | **Generic building blocks** (event stats, interval stats, metric series, paged lists) that work for any use case. Per-use-case endpoints only if a future number can't be expressed generically. |
| 3 | How does the frontend get the contract? | **Files at a git tag** (`contract-vX.Y`) on the public backend repo, fetched by a `contract:pull` script. No package registry. |
| 4 | Who builds the frontend? | **The backend developer builds the plumbing and one reference page** (Pony Rides). **The FE team builds the other pages**, the Config menu (including the zone editor) and the System log. |
| 5 | Snapshots, clips and live video in Phase 3 | **Snapshots and clips move into the API now** (the small part of the `media` module). The Live page shows stills plus live status. The annotated video waits for Phase 4's WebRTC and debug view. |
| 6 | Ports on a shared server | **Every host port is an env var** with a default; fixed container names go. |

## 1. Workstreams, the contract, and the order of work

### Workstreams

| Owner | Repo | Builds |
|---|---|---|
| Backend developer | `zoo-vision` | REST additions (section 2), WebSocket gateway (section 3), Caddy and the dev setup including the demo feeder (section 4), contract tags, Phase 1 and Phase 2 follow-ups |
| Backend developer | `zoo-vision-fe` | the plumbing and the Pony Rides reference page (section 5) |
| FE team | `zoo-vision-fe` | the other report pages, generic views, Live page, Config menu, System log, notices (section 5) |

### The contract

A contract version is a git tag `contract-vX.Y` on `Aryaputra34/zoo-vision`. At that tag, three files make up
the contract:

1. `apps/api/openapi.json`: every REST endpoint, its parameters and its response types. A script generates it
   from the NestJS code without starting a server; CI fails if the committed file is stale. The frontend
   generates its typed client and TanStack Query hooks from it with orval.
2. `packages/contracts/generated/web/index.d.ts`: the WebSocket message types, each use case's event `data`,
   interval `data` and metric names, as TypeScript types. Generated from `packages/contracts`, CI-checked like
   the rest of `generated/`.
3. `docs/fe-contract.md`: the guide for frontend developers: login and roles, the error shape and its codes,
   how reports work (buckets, timezone, `groupBy`), WebSocket rooms and messages, media URLs, and a changelog
   entry per tag.

The frontend runs `npm run contract:pull <tag>`. It downloads the files from
`https://raw.githubusercontent.com/Aryaputra34/zoo-vision/<tag>/...` (the repo is public, so no token), runs
orval, and the result is committed in the frontend repo, so every contract change is a readable diff in a
frontend pull request. For quick local iteration `contract:pull` also accepts a path to a local `zoo-vision`
checkout, but what is committed on the frontend's `main` always comes from a tag.

Versioning: `v0.x` while Phase 3 is in progress. A breaking change in `v0.x` is allowed only with a changelog
entry in `fe-contract.md`. The tag at the end of Phase 3 is `contract-v1.0`; from then on, `/api/v1` changes are
additive only (parent spec section 6).

### Order of work

The Config menu runs on endpoints that already exist (cameras, config versions, rollback, camera status,
latest frame, models, users, API tokens), so the FE team can start on it as soon as the plumbing lands.

| Step | Backend developer, backend | Backend developer, frontend | FE team |
|---|---|---|---|
| 1 | error shape, response types, `openapi.json` + CI, `GET /usecases`, Caddy, ports, demo feeder → **v0.1** | | |
| 2 | | plumbing on v0.1 | |
| 3 | reports, lists, CSV, snapshots, clips → **v0.2** | | Config menu and zone editor on v0.1 |
| 4 | WebSocket gateway and post-commit push → **v0.3** | Pony Rides on v0.2 | other report pages, generic views on v0.2 |
| 5 | system log endpoints, audit-camera notices, remaining follow-ups → **v0.4** | | Live page, live tiles, Saved → Applied over the WebSocket |
| 6 | the end-to-end run behind Caddy, **v1.0** | | System log pages |

Until v0.3, the config editor's Saved → Applied polls `GET /api/v1/cameras/:id/status`.

### Documents

- This design: `zoo-vision/docs/superpowers/specs/2026-10-14-phase-3-web-on-api-design.md`.
- Backend plan: `zoo-vision/docs/superpowers/plans/`.
- Frontend plan: `zoo-vision-fe/docs/superpowers/plans/`. Every task is marked **backend developer** or
  **FE team**. Backend-developer tasks are step by step; FE team tasks give the goal, the endpoints and
  messages to use, and acceptance criteria.

## 2. REST additions (backend developer)

All user routes are `/api/v1/...` except media (`/media/...`, as in the parent spec). Times in requests and
responses are ISO 8601; responses use UTC.

### Foundations (first, because the generated client depends on them)

**One error shape.** Today errors come back as a string, as `{message, errors}`, as `{message, fields}`, or as
class-validator's message array. Every error becomes:

```json
{
  "statusCode": 400,
  "code": "SETTINGS_INVALID",
  "message": "Settings are invalid",
  "errors": [{ "path": "/tripwire/start/0", "message": "must be <= 1" }]
}
```

- `code` is stable and machine-readable; the frontend switches on it and shows `message` as a fallback.
- `errors` (optional) lists per-field problems: validation failures (class-validator, ajv) and fields that need
  a higher role (today's `fields`).
- One global exception filter produces it, including for throttling (429), the transient-database filter
  (503) and unknown errors (500, no internal detail).
- Initial codes: `UNAUTHENTICATED` (401), `FORBIDDEN` and `ROLE_REQUIRED` (403, the latter with the fields in
  `errors`), `NOT_FOUND` (404), `VALIDATION_FAILED`, `SETTINGS_INVALID`, `FIELD_NOT_ALLOWED` and
  `RANGE_TOO_LONG` (400), `STALE_VERSION`, `USERNAME_TAKEN`, `LAST_SUPERADMIN`, `CAMERA_HAS_DATA` and
  `MODEL_IN_USE` (409), `TOO_LARGE` (413), `RATE_LIMITED` (429), `UNAVAILABLE` (503), `INTERNAL` (500). The full
  list, kept current per tag, lives in `fe-contract.md`.

**Response types.** Every existing and new route declares its response type for Swagger, so orval can type
it.

**Swagger.** `SWAGGER=off|superadmin|public`, default `off` (a Phase 1 follow-up). `superadmin` serves
`/api/docs` and `/api/docs-json` only to a SUPERADMIN session or a SUPERADMIN API token.

**Phase 1 follow-ups.** Express `trust proxy` set to 1 hop (Caddy), so the login throttle, the lockout and
`LoginLog` use the client's address. `/api/health` reports `up`/`down` per dependency without raw error text.
ioredis gets `maxRetriesPerRequest` and `commandTimeout`. `PUT /auth/password` gets a throttle.

### Use cases: `GET /api/v1/usecases` (all roles)

One entry per use case: `id`, `label`, `schemaVersion`, whether a camera can use it (it has settings), the
settings schema (dereferenced, defaults filled in, with `x-geometry` and `x-minRole`), each event type with its
`data` schema, each interval kind with its `data` schema, and each metric with its label and unit.

The zone editor draws every schema node marked `x-geometry` (`polygon` or `line`), including inside arrays:
the restaurant table list is an array of objects, each with an `id`, a `name` and a polygon. The threshold form
is generated from the remaining fields. Fields with `x-minRole` above the user's role are shown disabled.

### Reports (all roles)

Common parameters: `from`, `to`, and either `cameraIds` (comma-separated) or `useCase`. Buckets are aligned to
the site timezone, `SITE_TIMEZONE` (an IANA name, default `Asia/Jakarta`), until `SiteSettings` arrives in
Phase 4. `bucket` is `5m`, `15m`, `hour` or `day`.

| Endpoint | Parameters | Returns, per bucket and group |
|---|---|---|
| `GET /reports/events/stats` | `types`, `bucket`, `groupBy` (any of `camera`, `type`, `severity`, and up to two `data.<field>`), optional `max=<data field>` | `count`, and `max` when asked; `group` holds one value per `groupBy` item |
| `GET /reports/intervals/stats` | `kind`, `bucket`, `groupBy` (`camera` or `subject`) | `count`, `totalSec`, `avgSec`, `maxSec` |
| `GET /reports/metrics/series` | `name`, `bucket`, `agg` (`avg`, `max`, `min`) or `above=<number>` | the aggregate, or the number of minutes at or above the threshold |
| `GET /events` | `types`, `severity`, `where` (up to two `data.<field>:<value>` equality filters on declared fields), `cursor`, `limit` | newest first; each row has `snapshotUrl` (null without a snapshot) and `clipUrl` (null when the camera has no `recordingPath` or recording is off; the clip itself can still be gone, see Media) |
| `GET /intervals` | `kind`, `cursor`, `limit` | newest first |

- `groupBy` accepts only `data` fields the use case's event schema declares as a string or enum; `max` only
  fields declared as numbers. Anything else is a 400 (`FIELD_NOT_ALLOWED`). Field names never reach SQL as text.
  Two `data` fields cover the Vehicles page's type × direction table; `severity` covers the Overview's alert
  counts.
- An interval that crosses a bucket edge is split between the buckets. An open interval counts up to now (or
  up to `to`, if earlier).
- Range limits: `5m` up to 2 days, `15m` up to 7 days, `hour` up to 31 days, `day` up to 400 days. Lists:
  `limit` defaults to 100, at most 500; `cursor` is opaque.
- Examples. Pony Rides: departures and returns per hour today = `events/stats?types=horse_crossing&groupBy=
  data.direction&bucket=hour`; the 14-day table = the same with `bucket=day`. Cashier: unattended minutes per
  hour per desk = `intervals/stats?kind=desk_unattended&groupBy=camera&bucket=hour`; longest wait =
  `events/stats?types=customer_waiting&max=waitingSec`. Restaurant: the occupancy curve =
  `metrics/series?name=occupancy&agg=max&bucket=5m`; busy minutes = the same with `above=<warning capacity>`.

### CSV exports (all roles)

`GET /exports/events.csv`, `/exports/intervals.csv`, `/exports/metrics.csv` and `/exports/summary.csv` take the
same filters as the lists. `summary.csv` adds `bucket` (`hour` or `day`): one row per camera and bucket with
event counts per type, interval totals per kind and metric average and maximum per name.

- Streamed in batches, so a long range never loads into memory.
- UTF-8 with a BOM so Excel opens it cleanly; times in the site timezone.
- Every export writes an `AuditLog` row with its filters.
- Background export jobs, the Exports page and PDF stay in Phase 4.

### Media (any logged-in user)

- `GET /media/snapshots/<path>`: the JPEG the engine wrote (`<camera>/<YYYY-MM-DD>/<eventId>.jpg`) in the
  snapshot folder, which the API and the engine share (env `SNAPSHOT_DIR`, the name the engine already uses). `..` and absolute paths are
  rejected. `Cache-Control: private`.
- `GET /media/clips/<eventId>`: the API looks up the event's camera and time and asks MediaMTX's playback
  server (`MEDIAMTX_PLAYBACK_URL`) for the event time minus the camera's `clipBeforeSec` to plus its
  `clipAfterSec`, as MP4. Not cached while the clip's end is in the future. When the recording isn't
  available: 404 `RECORDING_NOT_AVAILABLE`.
- Pinning clips into `/data/evidence` and retention stay in Phase 4.

### System log (MANAGER and up)

| Endpoint | Filters | CSV |
|---|---|---|
| `GET /system-log/audit` | time range, actor, entity, action, audit cameras only | `/system-log/audit.csv` |
| `GET /system-log/logins` | time range, username, result | `/system-log/logins.csv` |
| `GET /system-log/system-events` | time range, type | `/system-log/system-events.csv` |

- System events are `Event` rows with use case `system`: `engine_started`, `events_dropped`,
  `config_rejected`, and a new `model_validation_failed` (added to the `system` contract as an optional new
  type), which the API writes when a model's validation fails. Camera downtime is
  `GET /intervals?useCase=system&kind=camera_offline`.
- Pages are newest first, with the same cursor paging as the lists.

### Audit cameras

A change to a camera with `auditCamera` set (camera fields, config save, rollback) writes its audit row with a
new column `AuditLog.auditCamera = true`, and the WebSocket sends an `audit.notice` to managers and superadmins
(section 3).

## 3. Live updates over the WebSocket (backend developer)

### The rule

The WebSocket only says "something changed" or carries small live values. REST stays the source of truth: a
page loads over REST, and after any disconnect the frontend refetches what it shows. A missed message can
never leave a page wrong, so the server keeps no replay buffer.

### Library and connection

- socket.io (`@nestjs/websockets` + `@nestjs/platform-socket.io`), path `/ws`, WebSocket transport only.
  Rooms, client reconnect and dead-connection detection are built in.
- The browser connects through Caddy and sends the session cookie automatically. The gateway resolves the
  session and loads the user from Postgres, as the REST guard does. No session or an inactive user: the
  handshake is refused with `UNAUTHENTICATED`, and the frontend goes to the login page.
- API tokens are not accepted on the WebSocket; it is for the dashboard.

### Rooms and messages

Client → server: `subscribe {rooms: ["status"]}` and `unsubscribe {rooms: [...]}`.

| Room | Members | Message | When |
|---|---|---|---|
| `alerts` | everyone, joined automatically | `event.created` `{id, time, cameraId, useCase, type, severity, data, snapshotUrl}` | after each ingest commit, one per new `Event`. A batch with more than 50 new events sends only `data.changed`. |
| `alerts` | everyone | `data.changed` `{cameraIds, useCases, shapes: ["event" \| "interval" \| "metric"]}` | after ingest commits, at most once every 5 s |
| `status` | on request | `status.snapshot` `{at, cameras: {<id>: status \| null}}` | every 2 s while the room has members; `null` = offline |
| `managers` | MANAGER and SUPERADMIN, joined automatically | `audit.notice` `{auditId, cameraId, actorName, action, time}` | when an audit-camera change commits |
| (any) | the affected user | `session.ended` `{reason}` | just before the server disconnects them (logout, disabled, role or password changed) |

- `status` carries what `cam:{id}:status` holds: `state`, `fps`, `lastFrameAt`, `appliedVersion`,
  `configError`, `restarts`, `live` counters. Saved → Applied ✓ (or Rejected with the reason) comes from
  `appliedVersion` and `configError`.
- `data.changed` is limited to once every 5 s because metric rows arrive every minute per camera and metric,
  which would otherwise refetch open pages every second. 5 s matches the prototype's page refresh. The first
  change after a quiet period is sent at once; later changes within the next 5 s are merged into one message at
  the end of that window. `event.created` is immediate, for alerts.
- Phase 4 adds `camera:{id}` rooms for boxes.
- The message types are JSON Schemas in `packages/contracts/ws/` and are generated into the web types file.
  Tests validate the gateway's real messages against them.

### How the push happens

The ingest service commits its Postgres transaction and XACKs, then hands the new rows to the gateway inside
the same process. A browser never sees an event that isn't in the database. A gateway failure is logged and
never affects ingest (parent spec: outputs never block ingest). There is one API process, so no socket.io
Redis adapter for now.

### Access changes

Disabling a user, changing their role or password, or logging out disconnects that user's sockets (after
`session.ended`). The gateway also rechecks every socket's session every 60 s, which catches expiry. After a
role change the client reconnects and lands in the right rooms.

### Failure cases

| Failure | Behaviour |
|---|---|
| API restarts | sockets drop; the client reconnects and refetches |
| Redis down | `status.snapshot` stops; after 10 s without one the frontend shows "live data paused" |
| Postgres down | no `event.created`; status keeps flowing (it comes from Redis); REST returns 503 and the frontend shows "backend unavailable" |

## 4. Caddy, ports and the development setup (backend developer)

### Caddy in production

A new `caddy` compose service holds the only exposed ports.

| Path | Goes to |
|---|---|
| `/api/*`, `/ws/*`, `/media/*` | the API |
| `/internal/*` | 404, never routed |
| everything else | the `web` service (Next.js) |

- TLS: Caddy's internal CA (its root certificate installed once on the park PCs) or the customer's
  certificate, chosen in `deploy/.env`.
- The API runs with `COOKIE_SECURE=true` and trusts one proxy hop.
- Security headers: no framing, `X-Content-Type-Options: nosniff`, a strict referrer policy.
- The `web` service: the frontend repo gets a Next.js standalone Dockerfile (plumbing). In Phase 3 compose
  builds it from a local frontend checkout (`ZOO_WEB_DIR`); publishing images to a registry stays in Phase 5.

### Caddy in development

`next dev` runs on the host for hot reload. Caddy runs in Docker and forwards `/` to
`host.docker.internal:<next dev port>` (`ZOO_WEB_UPSTREAM`; `extra_hosts: host-gateway` so it also works on
Linux). Everyone opens `http://localhost:<ZOO_HTTP_PORT>`. Cookies, the WebSocket and media URLs behave as in
production: no CORS, no Next.js rewrites. Plain http, `COOKIE_SECURE=false`.

### Ports and names

| Variable | Default | What |
|---|---|---|
| `ZOO_HTTP_PORT` | 80 | Caddy, http (8080 on the Acer dev laptop, where Apache holds 80 and 443) |
| `ZOO_HTTPS_PORT` | 443 | Caddy, https |
| `ZOO_API_PORT` | 3001 | the API on `127.0.0.1`, for the engine running from source and for debugging (hard-coded today) |
| `ZOO_REDIS_PORT` | 6379 | exists |
| `ZOO_PG_PORT` | 5433 | exists, override file only |
| `ZOO_WEB_UPSTREAM` | `web:3000` | in development, `host.docker.internal:3000` |

- Inside its container Caddy listens on the same port numbers as the host, so its http → https redirect and
  the URLs it builds carry the right port.
- The fixed `container_name`s (`zoo_postgres`, `zoo_api`, ...) are removed so two stacks can share a server;
  `COMPOSE_PROJECT_NAME` (default `zoo-vision`) prefixes the names. Docs that use the old names are updated.
- MediaMTX and the engine use host networking, so their ports are changed in their own settings (MediaMTX reads
  `MTX_*` variables). In Phase 3 only the clip endpoint talks to MediaMTX, through `MEDIAMTX_PLAYBACK_URL`.

### The demo feeder

The FE team has no GPU and no cameras. Without the engine nothing produces events, status or frames. The API
image gets CLI commands that play the engine's part, with no Python and no models, started by the compose
profile `demo`:

1. **`demo-seed`**: five demo cameras, one per use case, ids `demo_<use case>`, in engine group `demo` (the
   real engine on group `default` never runs them), with real settings (zones, tripwire, tables); and three
   users, `demo-superadmin`, `demo-manager` and `demo-user`, with the password from `DEMO_PASSWORD`. Runs only
   when `ZOO_DEMO=on`, so it can't create known-password users on a real site by accident.
2. **`demo-feed --backfill-days 14`**: 14 days of realistic history written into the Redis stream `events`, so
   it goes through the real ingest exactly like engine output: vehicle peaks at opening time, pony rides
   through the day, desk-unattended intervals, table sessions, occupancy curves.
3. **`demo-feed`, live**: new events, intervals and metrics every few seconds; `cam:{id}:status` every 5 s;
   a still image in `cam:{id}:frame` and, per event, in the snapshot folder.
4. **Config**: it listens on `cfg:changed`, fetches its group from `/internal/engine/cameras` with the engine
   token as the engine does, and reports the new `appliedVersion`, so Saved → Applied works in the demo.
5. **Outages**: every so often one demo camera stops reporting for 2 minutes, so offline intervals and the
   offline UI get exercised.

Every message passes the contracts validator before it is sent. Clips answer `RECORDING_NOT_AVAILABLE` (no
MediaMTX in the demo profile), and the frontend builds that state too.

The demo stills are synthetic (simple generated scenes with a grid), committed as small JPEGs. The backend repo
is public and frames from the demo videos show park visitors.

Running it:
- **FE team:** `docker compose --profile demo up -d`, then `npm run dev` in the frontend, then log in at
  `http://localhost:<ZOO_HTTP_PORT>`. Steps in `docs/fe-dev-setup.md`.
- **Backend developer, on the Acer laptop:** the same stack, plus the real engine from source on CUDA
  (RTX 3050, 4 GB) with 2–3 cameras on demo videos in group `default`, next to the demo cameras.

## 5. The frontend (`zoo-vision-fe`)

### Stack and layout

Added: axios, TanStack Query, orval, socket.io-client. Next.js 16 and Tailwind stay. The frontend needs no
backend URL and no secret: it only ever calls its own origin.

```
src/contract/         pulled at a tag: openapi.json, the web types, CONTRACT_VERSION
src/api/generated/    orval output (typed functions + TanStack Query hooks), committed
src/api/http.ts       axios instance (same origin; generated paths carry /api/v1); errors → ApiError {statusCode, code, message, errors}; 401 → /login
src/live/useLive.ts   socket.io connection, rooms, data.changed → refetch, "live data paused"
src/usecases/<id>/    custom report pages, one folder per use case (parent spec section 3)
```

### Plumbing (backend developer, step by step in the frontend plan)

1. `npm run contract:pull <tag | local path>` and the orval config. CI checks that the generated client matches
   the pulled `openapi.json`.
2. `http.ts` and error handling: one `ApiError`; a "backend unavailable" banner on 503 or a network failure.
3. Login: the login page posts to `POST /api/v1/auth/login`; `GET /api/v1/auth/me` drives a menu that shows each
   role only its items; logout; change password. `proxy.ts` only checks that the `zoo_session` cookie exists
   and redirects to `/login` if not. The API's 401 is the real check, and hidden menu items are a convenience;
   the API decides access.
4. `useLive()`: connect, join rooms, refetch report and list queries on `data.changed`, go to login on
   `session.ended` or a refused handshake, show "live data paused" after 10 s without `status.snapshot`.
5. Removal: `src/lib/db.ts`, `src/lib/session.ts`, `scripts/seed.mjs`, `data/zoo.db`, every route under
   `src/app/api/`, `src/app/api-docs/`, the frontend's own ingest API docs (`docs/API.md`, `docs/openapi.yaml`),
   `STATUS_SEC` and the heartbeat arithmetic, and the old variables in `.env.example`.
6. A Next.js standalone Dockerfile; CI: lint, typecheck, build, contract check.
7. `CONVENTIONS.md`: data fetching, error handling, role checks, live updates, where use case pages live.
8. Pony Rides on the new endpoints, as the reference page the FE team copies.

### FE team deliverables (goal, endpoints and acceptance criteria in the frontend plan)

| Area | Accepted when |
|---|---|
| Overview, Vehicles, Cashier, Restaurant (with tables) | every number comes from the report endpoints; refresh on `data.changed`; live tiles from `status.snapshot`; the evidence modal shows the snapshot and the clip, including "recording not available"; the CSV button uses the page's filters |
| Generic Events, Interval timeline, Metric chart | a use case the page has never seen appears with no code change (parent spec verification #5, tested with a dummy use case) |
| Live | camera stills every 2 s from `GET /api/v1/cameras/:id/frame`, with state and counters from `status.snapshot` |
| Cameras | create and delete for SUPERADMIN only; fields a MANAGER can't change are disabled; stream URLs never shown below SUPERADMIN; recording settings editable with a note that they apply from Phase 4 |
| Zone editor | draws what `x-geometry` asks for on the camera's latest frame, coordinates 0–1, stable ids for zones and tables; threshold form generated from the schema with `x-minRole` fields disabled; save sends `baseVersion`, and a 409 offers to reload; Saved → Applied ✓ or Rejected with the reason; version history with diff and rollback |
| AI models | ONNX upload with progress, a too-large file (413) handled; rescan, validate, convert, delete ("in use" handled) |
| Users, API tokens | the role rules of parent spec section 4; a new token is shown once |
| System log | Audit (audit-camera rows highlighted), Login history, System events; CSV for each |
| Notices | managers and superadmins get a toast on `audit.notice` |

UI text stays in Indonesian. The frontend owns its labels and falls back to the API's English labels for
anything it doesn't know.

## 6. Tests, the end-to-end run, follow-ups, and what is left out

### Backend tests

Jest unit tests and e2e tests against real Postgres and Redis containers (Testcontainers), as in Phases 1–2.

| Area | What the tests prove |
|---|---|
| Reports | known answers on seeded data; a crossing at 23:30 UTC lands on the next day in WIB; intervals split across buckets; open intervals count up to now; an undeclared `groupBy` field is a 400; range limits |
| Lists | cursor paging stays stable while new rows arrive |
| CSV | BOM, quoting, an audit row per export; 200k rows stream without loading into memory |
| Media | a session is required; `..` is rejected; clips against a fake MediaMTX playback server |
| WebSocket | a real socket.io client against the app: no cookie is refused; a rolled-back ingest pushes nothing; `data.changed` is limited to once per 5 s; disabling a user ends their socket; `audit.notice` never reaches a USER |
| Error shape | every exception type and the validation pipe return the one shape |
| Contract | CI fails on a stale `openapi.json` or web types file; gateway messages validate against the WebSocket schemas |
| Demo feeder | its messages pass the contracts validator; the backfill lands through the real ingest |
| Caddy | a smoke script: `/api/health` through Caddy; `/internal/*` is 404; the `/ws` upgrade works; Login history shows the client's address |

### Frontend tests

- Typecheck against the pulled contract, in CI.
- A `useLive` test: after a reconnect, queries are refetched.
- FE team: component tests for the zone editor's geometry. Playwright smoke tests against the demo stack are
  the FE team's call (parent spec section 8).

### The end-to-end run

The last backend step, on the Acer laptop, behind Caddy: the demo profile plus the real engine on CUDA with 2–3
cameras.

| Parent spec verification | Check |
|---|---|
| #1 | move a tripwire in the UI → Applied ✓; an invalid save is rejected with the reason |
| #3 | two cameras share one model, measured in GPU memory (a Phase 2 leftover) |
| #5 | a dummy use case appears in the generic views with no frontend change |
| #6 | the role rules; disabling a user cuts REST and the WebSocket; Swagger through a superadmin login and through an API token; failed logins show the client's address |
| #9, CSV half | CSV for 3 cameras over a week; the export is in the audit log |
| #10 | stop one feed → offline within ~15 s; the downtime shows in reports |

### Follow-ups

- **From Phase 1** (all in): one error shape, `trust proxy`, `SWAGGER` off by default, no raw error text in
  `/api/health`, ioredis timeouts, a `changePassword` throttle, the WebSocket push and the reports and
  system-log endpoints.
- **From Phase 2, taken into Phase 3:** one shared `EngineCamera` JSON fixture checked by an API e2e test and an
  engine test; the `mask_url` gaps (XMEye/Sofia-style path parameters, `#` or `;` inside a query value, a
  leading space); verification #3.
- **From Phase 2, still parked:** the `StreamManager` catch-up runaway (Phase 5 soak; the clips don't trigger
  it); ANPR rebuilt synchronously in the worker (fix when ANPR is switched on); a long ONNX conversion starving
  workers (Phase 5 soak); a config change while a worker thread is dead (accepted: it applies within 60 s).
- **Kept from Phase 2:** downtime is recorded only for cameras with `firstSeenAt`; file sources play in real
  time.

### Not in Phase 3

| Phase | Items |
|---|---|
| 4 | WebRTC live view with boxes (`camera:{id}` rooms); the superadmin debug view and retiring `core/api_server.py`; evidence pinning; retention jobs; `ExportJob`/BullMQ, the Exports page and PDF through Gotenberg; `SiteSettings` (the timezone becomes a setting); MediaMTX Control API sync, which is when recording settings take effect |
| 5 | publishing images to a registry |
| not planned | `LoginLog` session expiry, scheduled reports, alert acknowledgement |

## Changes to the parent spec

1. **Contract delivery:** git tags and `contract:pull` replace the npm package on GitHub Packages (section 6).
   GitHub Packages would need the scope `@aryaputra34` and a token for every install, even of a public package.
2. **Snapshots and clips** (part of the `media` module) move from Phase 4 to Phase 3. Pinning and retention
   stay in Phase 4.
3. **CSV in Phase 3 streams directly** from the API; background export jobs, the Exports page and PDF stay in
   Phase 4 (section 7 describes them together).
4. **`SWAGGER` gains a `superadmin` mode** and defaults to `off` (section 4 says "only shown to superadmins (or
   disabled by env var)").
5. **A `status` WebSocket room** carries every camera's status every 2 s, next to the parent spec's `alerts` and
   `camera:{id}` rooms; `managers` and `session.ended` are added; `data.changed` is limited to once every 5 s.
6. **The report timezone comes from `SITE_TIMEZONE`** until `SiteSettings` exists in Phase 4.
7. **The Live page in Phase 3 shows stills and live status.** Nothing in the web uses the engine's preview
   server any more; it retires in Phase 4 as planned.
8. **Host ports are env vars and fixed container names go** (section 6, deployment).
9. **New:** the demo feeder and its compose profile; `AuditLog.auditCamera`; the `model_validation_failed`
   system event written by the API.
