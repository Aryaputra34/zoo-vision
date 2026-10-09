# Zoo Vision: production architecture (design spec)

- **Status:** Approved design, awaiting spec review
- **Date:** 2026-10-08
- **Supersedes:** the prototype architecture in ADR-008 (Python engine + zoo-analytics-web). The
  ADR-008 decisions to keep MediaMTX, keep Python as the only analytics engine, and make Nx
  optional still hold. ADR-009 will record this spec's decisions (phase 5).

## Context

The prototype (zoo-monitor Python engine + zoo-analytics-web Next.js dashboard) was presented and
is now being rebuilt as a real product. The prototype keeps cameras and zones in YAML on the AI box
(read once at startup), delivers events over HTTP with an in-memory retry buffer, stores everything
in one free-form JSON `events` table in SQLite, has one shared password, and keeps the event format
in sync between Python and TypeScript by hand. This design replaces those shortcuts.

All sections were agreed one by one in the architecture review of 2026-10-07/08.

## Decisions

- **Deployment:** one customer (Taman Safari), one park, one on-site server. About 12 cameras.
  No cloud, no multi-site, no multi-tenancy.
- **Config:** a customer admin or a Magnet engineer adds cameras and draws zones in the web UI.
  Changes apply live, the way Network Optix does it, with no stream drop and no restart of the
  other cameras. The database is the source of truth.
- **Use cases are expected to change and grow.** Adding or changing a use case must not need a
  database migration or edits scattered across the codebase (see "Use case modules" below).
- **Required features:** config menu (cameras with recording settings, AI models with upload,
  ROI/tripwire editor), users and roles, system log for auditing (audit, login history, system
  events), PDF and CSV exports across multiple cameras (section 7).
- **Future:** fraud detection by reconciling camera counts with POS/ticketing sales (hooks now,
  module later; section 3); optional Nx integration.
- **Team:** one backend/CV developer (the project lead); a frontend team helps with the UI.
- **Stack (option B):**
  - Web (`zoo-vision-fe` repo): Next.js + Tailwind (frontend team). UI only, talks to the API,
    never to the DB.
  - `apps/api`: NestJS + Prisma (CRUD, migrations) + raw SQL / TypedSQL for reports. Views, indexes
    and summary tables live inside Prisma migrations, not loose `.sql` files.
  - Postgres (plain, no TimescaleDB).
  - `services/engine`: the Python vision engine.
  - Redis: the only channel between API and engine (section 1).
  - MediaMTX for recording and clips.
  - `packages/contracts`: JSON Schema as the single source for every use case's settings, events,
    intervals and metrics; generates TS types (api, published for web) and Pydantic models
    (engine); CI fails on stale generated code.
  - Two repos: backend `zoo-vision` (api + engine + contracts + deploy + nx, TypeScript and
    Python in separate folders) and frontend `zoo-vision-fe` (section 6). One docker-compose in
    `deploy/`.
- **Nx:** kept as an optional integration, not archived.
  - `integrations/nx/plugin/`: current `magnet_nx_plugin`, as-is, built only by an optional CI job.
    Future role: a thin bridge that forwards engine boxes/tracks/events to Nx (the SDK's
    `object_streamer` sample shows the pattern). It does not run its own detection.
  - `apps/api/src/nx/`: Nx REST client (bookmarks, alarms), off unless a site uses Nx.
  - Hooks built in now: optional `nxCameraId` + source type per camera; clip provider interface
    (MediaMTX now, Nx later); event outputs list in the API; per-frame boxes published on an
    internal channel; every box carries the source frame timestamp; zones owned by the web UI only.

## Design sections

### 1. Live config: how a change reaches a running camera (agreed)

**Flow**
1. Admin edits on a fresh raw frame from that camera. Coordinates stay normalized 0–1, as today.
2. API validates against the contracts schema, saves a new config version (author, time, diff:
   audit trail + rollback), and announces "camera X → v13".
3. Engine supervisor fetches v13 from the API, validates it with Pydantic, hands it to that
   camera's worker.
4. The worker applies it between two frames on its own thread, so `process_frame` never sees a
   half-applied config and no locks are needed.
5. Engine reports "applied v13" or "rejected v13: reason, still on v12". UI shows
   Saved → Applied ✓.
6. Every event carries `configVersion`, so a jump in a report traces back to a specific edit.
7. On engine start or reconnect it fetches the full snapshot and reconciles (start/stop/update
   cameras to match), so a missed notice can't leave it stale.

**Change classes**

| Change | Examples | What happens | Stream | Tracks / counters |
|---|---|---|---|---|
| Geometry | zones, tripwire, ROI, table polygons | zone objects rebuilt next frame | stays | kept; table state keyed by table id |
| Thresholds & display | confidence, timeouts, debounce, capacity, show_* | assigned next frame | stays | kept |
| Tracker tuning | lost_track_buffer, matching_thresh | new tracker | stays | track IDs restart once |
| Model | `modelId` (from the model registry, section 7), imgsz | new model loads in background, swapped when ready | stays | kept |
| Source | URL, target FPS | this camera reconnects | this camera only | kept |
| Use case | cashier → gate | this camera's pipeline rebuilt | stays if URL same | reset |

**Engine refactor this needs**
- Pipelines read `self.rules.get(...)` dicts in `__init__` and build zones lazily on the first
  frame (`_init_zones_if_needed` in each `pipelines/*.py`). Replace with a typed settings object
  (from contracts) and an `apply_config(settings)` method per pipeline.
- Reuse the count-preserving pattern of `set_tripwire()` in `pipelines/horse_riding_pipeline.py`
  and `pipelines/vehicle_gate_pipeline.py` for geometry changes.
- `core/table_manager.py` `TableOccupancyEngine`: rebuild table zones while keeping state for
  table ids that still exist; new tables start in a warm-up state that emits no event.
- `main.py` camera loop becomes a supervisor that owns one worker (StreamManager + pipeline) per
  camera and reconciles against the desired config.

**Transport: Redis (chosen).** One Redis container, AOF `everysec` so the event stream survives a
Redis restart.

| Key / channel | Direction | Purpose |
|---|---|---|
| pub/sub `cfg:changed` `{cameraId, version}` | API → engine | change notice; engine then fetches config from the API (`/internal/engine/...`, engine token) |
| stream `events` (XADD, capped length) | engine → API | durable events, interval open/close and metric samples (section 3) |
| hash `cam:{id}:status` (TTL ~15 s) | engine → API | liveness heartbeat + live state: fps, last frame, applied config version, state, error, live counters |
| pub/sub `cam:{id}:boxes` | engine → API (→ browser, future Nx bridge) | per-frame boxes + track ids + frame timestamp |
| key `cam:{id}:frame` (TTL) | engine → API | latest raw JPEG every ~2 s, for the zone editor and grid thumbnails |
| key `cam:{id}:debug` (short TTL) + pub/sub `cam:{id}:debugframes` | API ↔ engine | superadmin debug view: while the key exists the engine publishes annotated JPEGs (section 5) |

### 2. Engine internals (agreed)

Assumes the NVIDIA GPU from `docs/03_HARDWARE_SPECIFICATIONS.md` (RTX 3060/4070 12 GB or A4000/L4).

- **Process model (chosen: one process, split later):** one engine process: a supervisor plus one
  worker thread per camera (as in `main.py` `camera_worker` today). Docker restarts the process if
  it dies; on start it reconciles from the API, so cameras are back within seconds. Per-camera
  exceptions stay contained. A watchdog restarts only the worker whose stream delivers frames but
  which produced none for 30 s.
  - Every camera has `engineGroup` (default `"default"`). An engine process starts with
    `ENGINE_GROUP=<name>` and runs only that group's cameras, so moving a crash-prone camera
    (e.g. the gate with ANPR) or half the cameras to a second process is one compose service plus a
    config change.
  - Split when measured: one camera repeatedly crashing/leaking, or cameras below target FPS while
    the GPU is mostly idle and the engine is pinned at one core (GIL; check with `py-spy`).
- **Shared model pool:** today `BasePipeline.__init__` (`core/base_pipeline.py`) loads its own
  `YOLO(model_name)` per camera. Replace with one instance per (model file, imgsz) and one inference
  thread per instance; workers submit frames and wait; the thread batches frames that arrive within
  a few ms. Ultralytics model objects are not safe to call from several threads, so sharing needs
  this queue. Model hot-swap (section 1) = load a new pool entry in the background, then switch the
  camera's reference.
- **Decoding:** `core/stream_manager.py` decodes every frame on CPU and drops most of them to hit
  `target_fps`. Choose main or sub-stream per camera (MediaMTX relays both): main for tables/ANPR,
  sub-stream where enough. NVDEC decode only if measurements show CPU is the bottleneck.
- **Draw only when needed:** pipelines return results (detections, tracks, zone states) instead of
  an annotated frame every time. Drawing happens only for event snapshots and while a superadmin
  has the debug view open (section 5).
- **Timestamps:** keep wall-clock event time (NTP everywhere, per ADR-008) and also carry the
  stream timestamp on box metadata for overlay alignment (section 5).
- **Outputs:** events XADD to Redis; snapshot JPEGs go to a shared volume (`/data/snapshots`) that
  the API serves. The engine no longer runs its own HTTP server (`core/api_server.py` retires).
  Live video comes from MediaMTX, not the engine; the engine only encodes frames for the
  superadmin debug view (section 5).
- **Static config:** only env vars (Redis URL, API URL, engine token, device, data dir). Everything
  else comes from the API.

### 3. Data model and use case modules (agreed)

Postgres via Prisma. Timestamps stored as UTC `timestamptz`; reports use the site timezone
(Asia/Jakarta by default, a site setting).

**Config and users**
- `User` (username, name, bcrypt password hash, role `SUPERADMIN | MANAGER | USER`, active).
- `ApiToken` (name, hashed token, role, created by, last used, revoked) for Swagger/Postman/integrations.
- `AuditLog` (who, action, entity, before/after JSON, time) for every change to config, users,
  models, API tokens, plus every export.
- `LoginLog` (section 7).
- `Camera` (slug id like `cam_gate_entry_01`, name, area, `useCase`, enabled, `sourceType`
  `RTSP | MEDIAMTX | NX`, main/sub stream URLs (encrypted), `recordingPath`, `targetFps`,
  `engineGroup`, `auditCamera`, recording settings (on/off, main or sub stream, retention days
  override, clip seconds before/after), optional `nxCameraId`, `activeVersion`).
- `AiModel` (section 7).
- `CameraConfigVersion` (camera, version, `settings` JSONB, `schemaVersion`, author, time, note).
  Settings differ per use case, so JSONB validated against that use case's contract schema on write
  (API) and on load (engine). Zones, tripwires and tables live inside it with stable ids generated
  by the UI. Rollback = make an older version active again (creates a new version).
- `SiteSettings` (single row: park name, timezone, retention defaults for recordings, snapshots,
  kept clips, analytics data and logs, disk warning thresholds).
- `DeadEvent` (stream entries that failed validation or processing; section 3 event flow).
- `ExportJob` (who, filters, format, status, file path, expiry; section 7).

**Analytics data: stored by shape, not by use case.** Every use case produces some mix of three
shapes, so three generic tables hold all of them and a new use case needs no migration:

| Table | Shape | Columns | Today's examples |
|---|---|---|---|
| `Event` | something happened at a moment | id, time, camera, useCase, type, severity, `configVersion`, `schemaVersion`, snapshot path, `data` JSONB | vehicle crossing, pony departure, capacity alert, cashier alert |
| `Interval` | a state that lasted | camera, useCase, `kind`, `subjectId` (table id, desk…), start, end, `endReason`, `data` JSONB | table session, desk unattended, camera downtime |
| `Metric` | a number over time, one row per minute | camera, useCase, `name`, minute, value | restaurant occupancy, queue length |

- Indexes: `Event (camera, type, time)`, `Interval (camera, kind, start)`, `Metric (camera, name,
  minute)`. Hot JSONB fields get expression indexes when a report needs them (e.g. plate search on
  `data->>'plate'`). At ~10k rows/day this is plenty; no summary tables until a report is slow.
- A use case may still get its own typed table later if one report truly needs it; that is the
  exception, not the pattern. When it happens, derive it from the generic tables (a view or
  materialized view inside a Prisma migration) rather than writing it from the consumer.
- **Precedent:** generic events with typed-by-name JSON attributes plus a schema registry is how
  Snowplow (self-describing JSON Schema events, versioned), Segment/PostHog, and VMS metadata
  (Nx object types + attributes, ONVIF analytics) store analytics data. The three shapes mirror
  OpenTelemetry's logs / spans / metrics and Kimball's transaction / accumulating-snapshot /
  periodic-snapshot fact tables. Warehouses build typed per-process tables *downstream* of such a
  raw layer, which is the escape hatch above.
- **Scale escape hatch:** if `Metric` ever grows large, TimescaleDB is a Postgres extension that
  turns it into a hypertable without changing the schema. Not needed at ~10k rows/day.
- Live state (current occupancy, desk attended, fps) stays in Redis `cam:{id}:status`, never in
  Postgres.
- **Heartbeat, narrowed to its one real job: liveness.** "No events" can't tell a quiet camera
  from a dead one, so the engine refreshes `cam:{id}:status` every ~5 s with a ~15 s TTL; an
  expired key = camera offline (detected in ~15 s instead of today's 90 s). It is no longer stored
  in Postgres or used to compute reports (today `restaurant/page.tsx` multiplies stored status rows
  by `STATUS_SEC`).
- Camera downtime is an `Interval` (`kind = camera_offline`): the API opens it when a status key
  expires and closes it when the camera returns. Reports show these gaps, so "0 rides 10:00–10:20"
  can be told apart from "camera offline 10:00–10:20".

**Future: revenue assurance / fraud detection (hooks now, module later)**

Goal: detect mismatches between what was sold (POS / ticketing) and what the
cameras counted (e.g. pony rides counted vs ride tickets sold, vehicles entered vs gate tickets,
customers served at a cashier vs transactions). The industry name is POS-video integration /
exception-based reporting.

- Vision data stays in the generic tables; reconciliation counts `Event`/`Interval` rows per time
  window (or a derived view such as hourly ride departures).
- Sales data is financial and relational, so it gets **typed** tables when the module is built:
  `PosTransaction` (source, time, outlet, product, quantity, amount, receipt id),
  `ReconciliationRule` (camera + event filter ↔ outlet + product, window, tolerance),
  `ReconciliationResult` (window, vision count, POS count, difference, status, reviewer, notes).
  A mismatch becomes an `Event` (`reconciliation_mismatch`) linking the window's vision events and
  their snapshots/clips for review. A mismatch is a lead to review, not proof: camera counts have a
  measured error band per camera, which sets the tolerance.
- Hooks to build now (cheap):
  - `Event`, `Interval`, `Metric` are append-only for the API's DB role (no UPDATE/DELETE except
    closing an interval and the retention job), so counts can't be quietly edited.
  - Camera flag `auditCamera`: config changes on it are highlighted in reports and notify managers
    and superadmins, because moving a tripwire is the easiest way to hide sales. Every event
    already carries `configVersion`.
  - Longer evidence retention for audit cameras (section 5).
  - NTP on cameras, server and POS: matching by time window needs aligned clocks.
- Not built now: POS import (API, DB connector or CSV), rules, results, review UI. Designed in its
  own spec once the POS/ticketing system and its data access are known.

**Use case modules: adding or changing a use case**

Each use case is one module in three places, joined by its contract:

```
packages/contracts/usecases/<use_case>/
  settings.schema.json    geometry (polygon / line / list of named polygons) + thresholds
  events.schema.json      each event type and its data
  intervals.schema.json   each interval kind and its data
  metrics.json            metric names + units
services/engine/usecases/<use_case>/   pipeline class, registered by name (replaces the if/elif in main.py)
zoo-vision-fe: src/usecases/<use_case>/ optional custom report page (frontend repo)
```

- **No migration** to add a use case: its events, intervals and metrics land in the generic tables.
- **Works on day one without custom UI:** the zone editor reads geometry fields from
  `settings.schema.json` (polygon, line, named polygon list) and knows what to draw; the threshold
  form is generated from the same schema; the generic event log, interval timeline and metric chart
  show any use case. A custom report page is added only when wanted.
- **Changing a use case:**
  - Adding an optional field is always safe.
  - Never change the meaning of an existing field; add a new one instead.
  - A breaking change bumps `schemaVersion` on that use case. Old rows keep their version; reports
    handle both, or a one-off migration rewrites the old JSONB. Settings migrate on load.
  - CI validates example payloads against the schemas, and the generated TS/Pydantic types make the
    API, web and engine fail to build if they drift.

**Event flow (produce → consume → read)**
1. Engine: save snapshot JPEG to the shared volume, then `XADD events MAXLEN ~1000000` with the
   contract-validated payload. Three message kinds: `event`, `interval` (open/close sharing a
   `sessionId`), `metric`. Durable once XADD returns. If Redis is briefly unreachable, a small
   bounded in-memory buffer retries (replaces `core/analytics_dispatcher.py`'s HTTP queue).
2. API `EventsConsumer` (NestJS): one consumer in group `api`
   (`XREADGROUP ... COUNT 100 BLOCK 5000`). One consumer keeps per-camera order, which interval
   open/close pairs need. On start it first re-reads its own pending (delivered, un-acked) entries.
3. Per batch, one Postgres transaction: insert `Event` / open-or-close `Interval` / upsert `Metric`,
   idempotent on message id. Commit, then `XACK`. Redelivery after a crash is harmless, so delivery
   is at-least-once with no double counting.
4. After commit: push to browsers over the API's WebSocket gateway (new alert, tile refresh;
   replaces the 5 s page refresh) and to optional outputs (Nx bookmark). Output failures retry on
   their own and never block ingest.
5. Failures: API or Postgres down → entries wait in the stream (AOF) and are processed on recovery.
   Invalid payload or an entry that failed N times (`XPENDING` delivery count) → `DeadEvent` table
   + log, then ACK, so one bad event never blocks the rest.
6. Engine restart: the engine emits `engine_started` with a boot id first; the API closes that
   engine group's open intervals with `endReason = engine_restart`.
7. Reads: web pages call API REST endpoints; reports are raw SQL over the three tables; event log
   and CSV export read `Event`.

**Not included (YAGNI unless asked):** alert acknowledgement workflow, summary/rollup tables,
partitioning.

### 4. API, auth and roles (agreed)

Follows the team's TALK-MONITORING NestJS conventions where they fit (`@nestjs/passport`
local strategy, `bcrypt`, `@nestjs/swagger`, `@nestjs/websockets`, `@nestjs/schedule`,
`@nestjs/terminus`, `@nestjs/throttler`, `class-validator`).

**Edge:** Caddy in front of everything, one origin: `/` → web, `/api` → NestJS, `/ws` → NestJS
gateway, `/media` → snapshots/clips via NestJS. TLS with the customer's cert or Caddy's internal
CA. Same origin = plain cookies, no CORS. `/internal/*` is never routed by Caddy.

**Auth (chosen: Redis sessions):** login with the passport local strategy and bcrypt as the
team does; the session is an opaque random token in an httpOnly, SameSite=Lax cookie, stored in
Redis with user id + role (12 h sliding, 7 d max). Disabling a user or changing a role takes effect
on the next request. WebSocket handshake uses the same cookie. Login is rate-limited (throttler).
- The auth guard accepts either the session cookie (browser) or `Authorization: Bearer <token>`
  (Swagger "Authorize", Postman, scripts, future POS integration). Bearer tokens are API tokens a
  superadmin creates and revokes in the UI, stored hashed, each with a role.
- Swagger UI at `/api/docs` (same origin through Caddy): call `POST /api/auth/login` with
  "Try it out" and the browser keeps the cookie for every later call; or paste an API token into
  "Authorize". `DocumentBuilder` declares both (`addCookieAuth('zoo_session')`, `addBearerAuth()`).
  In production `/api/docs` is only shown to superadmins (or disabled by env var).

**Roles (fixed three; the team's dynamic role/menu-access pattern only if the
customer needs custom roles).** Prisma enum `Role { SUPERADMIN MANAGER USER }`.

| Action | User (viewer) | Manager (customer admin) | Superadmin (Magnet engineer) |
|---|---|---|---|
| Dashboards, live view, events, evidence, exports (CSV/PDF) | ✓ | ✓ | ✓ |
| Zones, thresholds, table names, enable/disable camera, rollback | | ✓ | ✓ |
| Manage user/manager accounts, site settings | | ✓ | ✓ |
| System log (audit, login history, system events); view recording settings | | ✓ | ✓ |
| Camera source URLs, model, tracker tuning, `engineGroup`, use case, `auditCamera` flag | | | ✓ |
| Recording settings; AI models (upload, rescan, convert, delete) | | | ✓ |
| Manage superadmin accounts, API tokens, debug view, `/api/docs` | | | ✓ |

- Field-level rules come from the contracts: settings fields marked `x-minRole: SUPERADMIN`
  (model, tracker tuning…) can only be changed by superadmins. The API compares old vs new on save;
  the UI disables those fields. New use cases get this for free.
- Changes on `auditCamera` cameras are allowed per role but always highlighted and notified.

**NestJS modules**
- `auth` (also writes `LoginLog`), `users`, `api-tokens`, `audit` (interceptor logs every
  mutating request with before/after), `system-log` (audit, login history, system events views).
- `cameras` (CRUD, config versions, rollback, publishes `cfg:changed`, reads applied status;
  syncs paths and recording settings to MediaMTX's Control API).
- `models` (registry, web upload, inbox rescan, convert to ONNX, validation via Redis).
- `exports` (BullMQ jobs: streamed CSV, PDF through Gotenberg).
- `usecases` (serves the contract registry: settings schemas for the editor/forms, labels).
- `ingest` (`EventsConsumer`, section 3) and `reports` (generic event/interval/metric queries +
  per-use-case raw SQL endpoints).
- `live` (WebSocket gateway: rooms `alerts` and `camera:{id}`; bridges Redis status/boxes to
  browsers and subscribes to a camera's Redis channel only while someone is in its room).
- `media` (auth-checked snapshots from the shared volume, clip proxy to MediaMTX; section 5).
- `engine-internal` (`/internal/engine/config...`, engine token, not routed by Caddy).
- `jobs` (`@nestjs/schedule`: offline detection from expired status keys → downtime intervals,
  retention cleanup).
- `nx` (optional outputs), `health` (terminus, used by compose healthchecks).

**Frontend contract:** REST + OpenAPI from `@nestjs/swagger`; the web gets a generated typed
client (e.g. orval generating axios functions, since the FE team uses axios). Live updates over
the `/ws` gateway replace the 5 s page refresh.

### 5. Video: cameras in MediaMTX, live view, evidence, retention (agreed)

**Cameras added in the UI reach MediaMTX without SSH.** MediaMTX's Control API (`:9997`,
`/v3/config/paths/add|patch|delete`) adds and changes paths at runtime. The API's `cameras` module
creates/updates/removes the MediaMTX path when a camera is saved, and re-syncs all paths on API
start. `deploy/mediamtx.yml` keeps only defaults (recording format, retention, ports). Camera
URLs contain passwords: stored encrypted (AES-GCM, key from env), visible only to superadmins.

**Live view (chosen: WebRTC + browser boxes for everyone, plus a superadmin debug view).**

*Debug view (superadmin only):* the engine's own annotated frames, as today. While a superadmin
has it open, the API keeps a Redis key `cam:{id}:debug` alive (short TTL, refreshed while
connected); only then does the engine draw and publish JPEGs (~5 FPS) on `cam:{id}:debugframes`,
which the API serves as MJPEG at `/media/debug/{id}`. No viewer = no encoding. Used for tuning,
because it shows exactly what the pipeline sees, including internal overlays.

*Main live view:*
- Video: MediaMTX serves each camera over WebRTC (WHEP), H.264 passed through with no
  re-encoding; sub-stream in the grid, main stream when a camera is opened. Caddy routes
  `/media/webrtc/*` to MediaMTX behind `forward_auth` to the API, so only logged-in users get video.
- Boxes: the browser joins the `camera:{id}` WebSocket room and receives that camera's boxes,
  track ids and labels from Redis `cam:{id}:boxes`; zones come from the camera's config. A canvas
  over the video draws them. Boxes are held in a short buffer and drawn against the measured video
  delay, so they line up within a few frames (good for monitoring, not frame-exact).
- Use-case overlays (table badges, occupancy card, desk state) are drawn by the web from
  `cam:{id}:status`, so the engine never encodes live video.
- Same box stream the future Nx bridge would consume.
- Requires H.264 from cameras (already required for clips, ADR-008).

**Evidence**
- Snapshot: at event time the engine draws boxes + zones on that frame and writes
  `/data/snapshots/{camera}/{date}/{eventId}.jpg`; the API `media` module serves it after the
  session check.
- Continuous recording: MediaMTX records every camera, main or sub-stream per camera, for N days
  (site default 7, per-camera override; recording settings in section 7).
- Kept clips ("pinning"): a job copies [t − before, t + after] (per-camera clip length, default
  15 s + 15 s) from the MediaMTX playback server into
  `/data/evidence/` so it survives the continuous retention, for:
  1. warning/critical events;
  2. events a user marks "Keep evidence";
  3. every event on `auditCamera` cameras;
  4. later, whole reconciliation-mismatch windows (fraud module).
  Kept clips are served with HTTP range support (fixes ADR-008's "whole file before seeking" for
  them). Unpinned clips still stream from MediaMTX playback while inside the retention window.
- Clip provider interface: MediaMTX now, Nx archive later.

**Disk sizing (per ~12 cameras, rough)**

| Data | Rate | Default retention | Size |
|---|---|---|---|
| Continuous, main stream 4 Mbit/s | ~43 GB/day/camera | 7 days | ~3.6 TB |
| Continuous, sub-stream 1 Mbit/s | ~11 GB/day/camera | 7 days | ~0.9 TB |
| Kept clips (30 s ≈ 15 MB) | depends on event volume | 1 year | sized from real counts |
| Snapshots (~150 KB) | few thousand/day | 90 days, audit cameras 1 year | tens of GB |
| Postgres | ~10k rows/day | 2 years | a few GB |

Recording sub-stream where the main stream isn't needed is the biggest single saving. Retention
values are site defaults with per-camera overrides; the API warns when free disk drops below a
threshold.

### 6. Repo, deployment and the path from the prototype (agreed)

**Two repos (chosen): a backend repo with TypeScript + Python, and a frontend repo.** API and
engine share the contracts tightly, so they stay together; the web only depends on the HTTP/WS API.

```
zoo-vision/                 backend (this repo, remote Aryaputra34/zoo-vision)
  apps/api/                 NestJS + Prisma (TypeScript; npm; Jest; own Dockerfile)
  services/engine/          Python (pyproject + uv; pytest; own Dockerfile): core/, usecases/<name>/
  packages/contracts/       JSON Schema per use case → generated TS types + Pydantic models
  integrations/nx/plugin/   current magnet_nx_plugin, frozen; README pins the SDK version
  deploy/                   docker-compose.yml, Caddyfile, mediamtx.yml (defaults), .env.example,
                            install / backup / update scripts
  tools/                    export_model.py, fetch_models.py, calibration/benchmark scripts worth keeping
  docs/                     existing ADRs + ADR-009 for this architecture; guides

zoo-vision-fe/              frontend (today's Aryaputra34/zoo-analytics-web, renamed)
  Next.js + Tailwind, pure TypeScript; no DB access (src/lib/db.ts and src/app/api/* removed)
```
- Each backend folder is self-contained (own deps, linter, tests, image). API and engine never
  import each other; they talk through Redis and `/internal/engine/*` at runtime.
- `packages/contracts`: one command regenerates both the TS types and the Pydantic models;
  generated code is committed and CI fails if it is stale.
- What the frontend gets from the backend:
  1. the OpenAPI document (published by backend CI per release) → typed axios client via orval;
  2. npm package `@zoo-vision/contracts` on GitHub Packages: WebSocket message types and use case
     schema types;
  3. use case settings schemas at runtime from the `usecases` module (zone editor, forms).
- API is versioned (`/api/v1`) and kept backward compatible; the FE pins a contracts version;
  `deploy/.env` pins the FE image version that goes with each backend release.
- CI (GitHub Actions, path filters). Backend: contracts (generate + fail on diff, publish
  package), api (lint, unit, e2e against Postgres/Redis containers), engine (ruff, pytest), nx
  plugin (manual). Frontend: lint, typecheck against the pinned contracts, build, image.
- Out of git from phase 0 on: models (`.onnx/.pt/.engine`) are fetched by `tools/fetch_models.py`
  from a release or file share with checksums in `models/manifest.json`; MediaMTX comes from its
  Docker image, so `mediamtx.exe`, `mediamtx/*.tar.gz` and tracked `yolo11s.onnx` leave the repo;
  small test videos go in Git LFS.
- **Git history left as-is (chosen).** History is 238.6 MB, of which 236.7 MB is old binaries
  (`mediamtx.exe`, three versions of `yolo11s.onnx`, the MediaMTX tarball, OpenVINO `.bin`, a demo
  video, scratch JPEGs) and 1.9 MB is code. Only backend developers do full clones (CI checks out
  one commit), so no rewrite now; `git filter-repo` remains an option if the repo is shared widely.

**Deployment (one park server, Ubuntu LTS + NVIDIA Container Toolkit)**

| Service | Notes |
|---|---|
| `caddy` | the only exposed ports (443/80); TLS; routes `/`, `/api`, `/ws`, `/media`; `forward_auth` for WebRTC |
| `web` | image built by the `zoo-vision-fe` repo (Next.js standalone); version pinned in `deploy/.env` |
| `api` | NestJS; runs `prisma migrate deploy` on start |
| `engine` | GPU; `ENGINE_GROUP=default`; more engine services only if split later |
| `postgres` | volume `pgdata` |
| `redis` | AOF `everysec`, volume `redisdata` |
| `mediamtx` | host network for WebRTC ICE on the LAN; volume `/data/recordings` |
| `gotenberg` | headless Chromium for PDF exports (section 7); internal only |

- Data volumes: `/data/snapshots`, `/data/evidence`, `/data/recordings`, `/data/models` (incl.
  `inbox/`), `/data/exports`, `/data/backups`.
- Healthchecks on every service; `restart: unless-stopped`.
- Backups: nightly `pg_dump` to `/data/backups` (+ optional NAS/USB copy); config export (cameras,
  versions, users without hashes) downloadable by superadmins.
- Updates: CI builds versioned images. Online site: `docker compose pull && up -d`. Offline site:
  `docker save` tarball on USB + `deploy/update.sh`.

**Path from the prototype: phases, each ending in a working system**
0. **Restructure:** this repo (remote `Aryaputra34/zoo-vision`) becomes the backend repo; the
   engine moves to `services/engine`, binaries leave git, CI added. zoo-analytics-web is renamed
   `zoo-vision-fe`. Behaviour unchanged.
1. **Backbone:** Postgres + Prisma schema, Redis, contracts package, NestJS auth (sessions, API
   tokens, `LoginLog`), users, audit, cameras, `EventsConsumer`. Engine sends to the Redis stream
   instead of HTTP but still reads YAML; a one-off script imports today's `cameras.yaml` +
   `rules/*.yaml` into camera config versions.
2. **Live config engine:** supervisor, use case registry, typed settings + `apply_config`, shared
   model pool, config from the API, status heartbeats, `engineGroup`; AI model registry (inbox
   rescan, validation, convert to ONNX).
3. **Web on the API** (`zoo-vision-fe`): pages ported from `src/lib/db.ts` to the generated API
   client, WebSocket live updates, config menu (cameras, models incl. upload, zone editor driven by
   settings schemas, users, API tokens), system log, generic event/interval/metric views, CSV
   exports.
4. **Video and evidence:** MediaMTX Control API sync incl. recording settings, WebRTC + overlay,
   superadmin debug view, evidence pinning, retention jobs, disk warnings, PDF exports (Gotenberg).
5. **Hardening:** backups, install/update scripts, offline update path, System status page, soak
   test on target hardware, docs and ADR-009.

Later, each with its own spec: fraud detection (POS reconciliation), Nx bridge.

Each phase gets its own implementation plan (writing-plans) after this spec is approved.

### 7. Product features: menus, AI model registry, recording, system log, exports (agreed)

**Menus** (role table in section 4 decides what each role sees)
- Dashboard · Live · Reports (per use case) · Events
- Config: Cameras (incl. recording settings) · AI Models · Zones & Tripwires (per camera) · Users ·
  API tokens · Site settings
- System log: Audit · Login history · System events
- Exports

**AI models: registry + upload**
- `AiModel` (name, version, format, file path, sha256, class names, default imgsz, status
  `UPLOADED | VALIDATING | READY | FAILED`, validation report: loads OK, latency, classes;
  uploaded by/at, notes). Built-in models are seeded at install by `tools/fetch_models.py`.
- Two ways in:
  1. **Web upload** (superadmin): **ONNX only**. A `.pt` file is a Python pickle that can run any
     code when loaded, so a web upload of `.pt` would let anyone with a superadmin login (or a
     stolen session) run code on the server.
  2. **Drop-in folder** (someone with server access): copy `.onnx`, `.pt` or TensorRT `.engine`
     into `/data/models/inbox/`, then press "Rescan" in the UI (also scanned on API start). Server
     access is already fully trusted, so `.pt` is allowed here. Registered with source
     `filesystem`.
- Every new model, whichever way it came in, goes through the same check: API publishes
  `model:validate {id}` on Redis → engine loads it, runs a test inference, reads class names,
  measures latency, reports back → `READY` or `FAILED`. Only `READY` models can be selected.
- `.pt` models run on PyTorch (already in the engine image via Ultralytics) and are usually slower
  than ONNX/TensorRT, which `scratch/benchmark_pt_onnx_openvino.py` measured. Good for trying a
  model; for production a superadmin presses "Convert to ONNX" on a `.pt` model: an engine job
  reusing `tools/export_model.py`'s export logic creates a new ONNX entry that goes through the
  same check. `.engine` files only load on the matching GPU + TensorRT version; the check catches
  a mismatch.
- Camera settings reference `modelId` + imgsz (`x-minRole: SUPERADMIN`); changing it triggers the
  background hot swap (section 1). A model in use can't be deleted. Class pickers in use case
  settings (e.g. vehicle classes) validate against the selected model's class list.
- Later, optional: the engine builds and caches a TensorRT `.engine` from the ONNX per GPU.

**Recording settings (per camera, superadmin; managers can view)**
- Recording on/off, which stream to record (main = full quality, sub = lower quality), how many
  days to keep (overrides the site default), and the evidence clip length (seconds before/after an
  event; default 15/15).
- Applied live through MediaMTX's Control API (`record`, `recordDeleteAfter`, source path); no
  restart.
- "Quality" means choosing the camera's main or sub-stream. MediaMTX records without re-encoding,
  so changing bitrate/resolution itself is done in the camera's own settings (re-encoding on the
  server would cost CPU/GPU).
- The form shows a disk estimate: the camera's measured bitrate (MediaMTX reports bytes received
  per path) × days kept, next to free disk space.

**Zones & tripwires editor:** as in sections 1 and 3: drawn on the camera's latest frame
(`cam:{id}:frame`), geometry fields from the use case schema, Saved → Applied ✓, version history
with diff and rollback.

**System log (all append-only for the API's DB role; retention default 1 year, a site setting)**
- Audit: `AuditLog` (section 3) covers config, user, model, token changes and every export.
- Login history: `LoginLog` (time, username as typed, user id if matched, result: success / wrong
  password / disabled / locked / rate-limited, IP, user agent, logout or expiry). Repeated failures
  lock the account for a period.
- System events: camera offline/online (downtime intervals), engine started/crashed, config
  rejected, model validation failed, low disk. Stored as `Event` rows with use case `system`.
- Viewable with filters by superadmins and managers; CSV export.

**Exports**
- Filters: date range, one or many cameras (or all cameras of a use case), use case, event types.
- CSV: raw events / intervals / metrics, and summaries (per camera per hour or day). Streamed from
  a Postgres cursor so big ranges never load into memory. UTF-8 with BOM so Excel opens it cleanly.
- PDF summary: a print-styled report page in the web app (same charts as the dashboard) rendered
  by a Gotenberg container (headless Chromium). One section per camera plus totals; day, week or
  month.
- Background jobs via BullMQ on the existing Redis (`@nestjs/bullmq`): the Exports page shows
  progress and a download link; files kept 7 days. Small CSVs stream directly.
- Not now: scheduled email reports.

### 8. Testing and error handling (agreed)

**Tests by layer**
- **Contracts:** example payloads per use case (valid and invalid) checked in CI; codegen diff
  check.
- **Engine (pytest):**
  - Logic without a model: pipelines take detections and return results, so cashier states,
    tripwire crossings, table sessions and `apply_config` transitions (geometry change keeps
    counts and tracks; table state survives; new table warm-up emits nothing) are tested with
    synthetic detections. The useful `scratch/test_*.py` checks (dwell filter, cashier transition,
    tripwire) become real tests.
  - Golden clips: short clips cut from the demo videos (`demo_kasir.mp4`, `demo_kuda.mp4`,
    `demo_restaurant.mp4`, `demo_gate.mp4`, in Git LFS) with hand-counted expected results
    (e.g. pony departures, gate entries) and a tolerance. They catch regressions when models or
    thresholds change, and they measure each use case's error band (which later sets fraud
    tolerances). Run on demand and nightly, not on every push.
  - Integration with a real Redis container: config notice → apply → status shows the version;
    events land in the stream with the right shape.
- **API (Jest):** unit tests for config versioning, `x-minRole` field rules and interval
  open/close; e2e (supertest) against real Postgres and Redis containers for ingest idempotency
  (same message twice = one row), pending-entry recovery after a crash, dead-lettering, cookie and
  Bearer auth with revocation, the role matrix, append-only tables (DB role can't UPDATE/DELETE),
  and report SQL against seeded data with known answers.
- **Frontend (its repo):** typecheck against the pinned contracts; component tests for the zone
  editor's geometry; Playwright smoke tests against a running backend (frontend team's call).
- **Whole system:** docker-compose with MediaMTX fed by FFmpeg looping test videos (as in
  `docs/09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md`); runs the scenarios in the Verification section.
- **Soak test before installing at the park:** 12 simulated cameras for 24 h on the target
  hardware: FPS per camera, GPU memory, CPU, memory growth (leaks), disk growth against the
  estimate.

**Error handling (summary across sections)**

| Failure | Behaviour |
|---|---|
| Camera stream drops | that worker reconnects with backoff; status shows "reconnecting"; downtime interval once the status key expires |
| Engine crash | Docker restarts it; it reconciles config; `engine_started` closes open intervals |
| Invalid config | API rejects it on save; if the engine rejects it, it keeps the previous version and the UI shows the reason |
| Model fails its check | stays `FAILED`; cameras keep their current model |
| Redis down | engine holds events in a bounded memory buffer and reports how many were dropped once Redis is back; live views pause; config reconciles on reconnect |
| Postgres down | events wait in the Redis stream; API reads return 503; healthcheck red |
| API down | engine unaffected; events wait in the stream; web shows "backend unavailable" |
| MediaMTX down | cameras go offline (downtime intervals), recording gap; clip pinning retries; events still have snapshots |
| Disk filling | system events at 85% and 95%; MediaMTX retention keeps deleting the oldest recordings; pinned evidence is never auto-deleted before its own retention |
| Clock drift | NTP everywhere; the API compares engine timestamps with its own clock and raises a system event above 2 s |
| Gotenberg down | PDF export jobs retry and then fail visibly; CSV unaffected |

**Observability:** JSON logs from API and engine with Docker log rotation; a System status page
(each service, per-camera FPS and applied version, GPU memory/utilisation reported by the engine,
disk space). Prometheus/Grafana only if the site needs it later.

## Verification (end-to-end scenarios the finished system must pass)

Run on the full docker-compose stack with MediaMTX fed by FFmpeg looping the demo videos.

1. **Live config (s1):** move a tripwire in the UI while the pony video plays → Applied ✓ within
   ~1 s; engine logs show no stream reconnect; track ids unchanged; crossing counts continue. Save
   an invalid polygon → rejected with a reason, previous version keeps running.
2. **Model swap (s1, s7):** switch a camera to another READY model → video never stops; new model
   active after loading; drop a `.pt` into `inbox/`, Rescan → validated → Convert to ONNX → new
   READY entry. Upload a `.pt` through the web → refused.
3. **Engine (s2):** two cameras on one model share one loaded instance (GPU memory checked);
   kill the engine container → it restarts, cameras resume, open intervals closed with
   `engine_restart`.
4. **Durable events (s3):** stop the API 5 minutes while the engine runs → restart → every event
   from the gap is in Postgres exactly once. Feed a malformed entry → lands in `DeadEvent`, the rest
   keep flowing.
5. **New use case (s3):** add a dummy use case module (contract + engine pipeline only) → its
   events, intervals and metrics are stored and shown in the generic views with no migration and
   no web change.
6. **Auth and roles (s4):** a USER can't open config; a MANAGER can edit zones but not the model;
   disabling a logged-in user cuts access on the next request; Swagger works via login and via an
   API token; failed logins appear in Login history.
7. **Video and evidence (s5):** WebRTC live view with boxes over it; no video without a session;
   superadmin debug view shows annotated frames and the engine stops encoding when it closes; a
   warning event's clip is still playable after its recording segment has been deleted.
8. **Recording settings (s7):** switch a camera to sub-stream and 3-day retention → applied in
   MediaMTX without restart; disk estimate updates.
9. **Exports (s7):** PDF and CSV for 3 cameras over a week → downloads from the Exports page; the
   export appears in the audit log.
10. **Downtime (s3, s8):** stop one FFmpeg feed → camera offline within ~15 s, a downtime interval
    appears in reports, other cameras unaffected.
11. **Soak (s8):** 12 simulated cameras for 24 h on the target hardware → target FPS held, no
    memory growth, disk growth matches the estimate.

## Next steps

1. Review this spec and apply any changes.
2. Write the implementation plan for **Phase 0 (restructure)** only. Later phases get their own
   implementation plans when reached.
