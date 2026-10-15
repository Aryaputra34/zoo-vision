# Zoo Vision Phase 4a (Live Video), Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every camera added in the web UI becomes MediaMTX paths that the API keeps in sync, recorded per its
settings and read by the engine through MediaMTX. A logged-in browser plays it over WebRTC through Caddy and gets
the engine's boxes over the WebSocket; a SUPERADMIN can open the engine's annotated frames. Nothing on the LAN
reaches video without a dashboard session or the MediaMTX service password. Ends with tag `contract-v0.5`.

**Architecture:** A new `apps/api/src/mediamtx/` module owns the `zv_*` paths: one pure function derives the wanted
paths from the cameras, one reconcile pass diffs them against MediaMTX's Control API (after every camera commit and
every 30 s), and a stream-info service reads path status and disk. Caddy routes WHEP to MediaMTX behind
`forward_auth` to a new `GET /auth/check`. The engine publishes boxes (every frame) and debug JPEGs (only while a
Redis key says someone watches) on Redis pub/sub; the API relays boxes into `camera:<id>` WebSocket rooms and debug
frames as MJPEG. `core/api_server.py` is deleted.

**Tech Stack:** as in Phase 3 (Node 22, NestJS 11, Prisma 7, ioredis, socket.io, ajv, Jest + supertest +
Testcontainers; Python 3.12 + uv, pytest, redis-py, OpenCV, supervision), MediaMTX 1.21.1 Control API v3, Caddy
`forward_auth`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-phase-4a-video-design.md` (approved), which refines
`docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md` sections 5–8. The frontend half
is `D:\WORK\zoo-analytics-web\docs\superpowers\plans\2026-10-15-phase-4a-video-web.md`.

## Global Constraints

- Work in `D:\WORK\zoo-vision` on branch `phase-4a-video` (it holds the design commits). Never commit to `main`.
  Push the branch and the tag only after the user says yes.
- No Claude attribution: no `Co-Authored-By` trailer, no "Generated with Claude Code" line, in commits or pull
  requests. Put this rule in every implementer prompt.
- No test-first steps (memory `no-tdd-in-plans`): implement, then one focused test where the logic is risky.
  Verification runs stay.
- The Acer laptop (memory `dev-laptop-constraints`): RTX 3050 4 GB, engine from source with `uv` on CUDA, at most
  3 cameras; never build the engine image; Docker Desktop must be running for Testcontainers and compose; ports
  80/443/5432 are taken (Caddy on 8080). MediaMTX runs natively: `.\mediamtx.exe deploy\mediamtx.yml` from the
  repo root. Never run a bare `docker compose up`.
- Don't edit historical documents: `docs/adr/*`, `docs/01_*`, `docs/04_*`, `docs/06_*`,
  `docs/architecture_best_practice_recommendation.md`, the parent spec, the Phase 0–3 plans and specs.
- Image tags stay `postgres:17.11-alpine`, `redis:7.4.11-alpine`, `bluenviron/mediamtx:1.21.1`,
  `caddy:2.11.7-alpine`.
- Contract: everything additive over v0.4, except a wrong current password becoming `WRONG_PASSWORD` (changelog
  entry). No use case's `schemaVersion` changes. One tag, `contract-v0.5`, at the end (Task 11). Every change gets
  a line in `docs/fe-contract.md` section 14 under `### v0.5`.
- Never put these in logs, audit rows, WebSocket messages, MediaMTX error texts we log, or responses below
  SUPERADMIN: passwords, `MEDIAMTX_PASSWORD`, API tokens, `ENGINE_TOKEN`, camera stream URLs (MediaMTX `source`
  values carry them: log path names only).
- Numbers fixed here:

  | What | Value |
  |---|---|
  | Path names | `zv_<cameraId>`, `zv_<cameraId>_sub`; anything not starting with `zv_` is never touched |
  | Reconcile | at API start, after each camera commit, every 30 s (only with `JOBS=on`) |
  | Control API calls | basic auth `zoo:<MEDIAMTX_PASSWORD>`, 5 s timeout each |
  | Retention when `retentionDays` is null | 7 days (`recordDeleteAfter: 7d`) |
  | Bitrate | from two `bytesReceived` readings 1–120 s apart, else null |
  | `boxes` to a room | at most 10 per second per camera (a message < 100 ms after the last one is dropped) |
  | Debug key `cam:{id}:debug` | TTL 5 s, refreshed every 2 s while a viewer is open |
  | Engine debug frames | keys checked once a second; at most 5 JPEGs/s per watched camera, at most 960 px wide, quality 70 |
  | Trusted proxy | the addresses `TRUSTED_PROXY_HOST` (default `caddy`) resolves to, re-resolved every 60 s |
  | MediaMTX ports | RTSP 8554, playback 9996, Control API 9997, WebRTC HTTP 8889, WebRTC ICE UDP 8189 |

## Decisions this plan makes beyond the design

The user should confirm these when reviewing the plan.

1. **`recordingPath` is computed, not stored.** One function (`mediamtxPaths`, Task 2) gives the recorded path
   from `recordingEnabled`, `recordingStream`, the sub URL and `sourceType`; the camera view and clips use it. The
   `Camera.recordingPath` column stays but is unused (no migration in 4a; drop it in 4b's migration). A value sent
   in create/update is still accepted by the DTO (the global pipe forbids unknown fields) and ignored.
2. **`SUB` without a sub URL falls back to main**, for recording as it already does for inference.
3. **Camera ids ending in `_sub` are refused on create** (400 `VALIDATION_FAILED`): camera `gate_sub`'s main path
   would collide with camera `gate`'s sub path.
4. **Every sync is a whole reconcile.** A camera commit calls `PathSync.request()`, which runs one full diff (or
   marks one rerun if a pass is running). With ~12 cameras one `paths/list` call is cheap, and there is only one
   code path to test.
5. **The engine reads MediaMTX only when the API has MediaMTX configured** (`MEDIAMTX_API_URL` set). Without it
   (demo profile) `sourceUrl` stays the camera's own URL, as today, and `liveUrls` is null.
6. **`RTSP`, `MEDIAMTX` and `NX` source types all get `zv_` paths;** only `FILE` gets none.
7. **Anonymous localhost may read `feed_*` paths** (`authInternalUsers` entry with `path: ~^feed_`), so a test
   camera's source `rtsp://127.0.0.1:8554/feed_<name>` needs no password. Everything else needs user `zoo`.
8. **Caddy gets the MediaMTX basic-auth header from its start command:** the `caddy` service runs
   `sh -c` that exports `ZOO_MEDIAMTX_BASIC=$(printf 'zoo:%s' "$MEDIAMTX_PASSWORD" | base64 | tr -d '\n')` before
   `caddy run`. One secret in `.env`, no hand-made base64.
9. **One `RedisPubSub` provider** (in `redis/`), with reference-counted `subscribe(channel, onMessage)`, serves both
   the boxes relay and the debug view on one duplicate connection.
10. **Boxes from pipelines without a tracker** (`cashier_presence`, `restaurant_table`) carry `trackId: null`; the
    browser draws them without gliding.
11. **The engine never blocks a camera thread on Redis for boxes:** `BoxPublisher` keeps only the latest box set
    per camera and a thread publishes it, the same idea as `EventStream`.
12. **`/media/webrtc/*` passes only the WHEP calls** `reader.js` makes: `OPTIONS`/`POST` on `zv_…/whep` and
    `PATCH`/`DELETE` on `zv_…/whep/<session>`. MediaMTX's `Location` header is rewritten under `/media/webrtc/`.
13. **The MediaMTX `pathDefaults` stop recording** (`record: false`); the API turns it on per `zv_` path. The
    hand-written test feeds are renamed `feed_*` and never record.

## Follow-ups (from memories `phase-3-followups`, `phase-2-followups`)

| Item | Where |
|---|---|
| MediaMTX `:9996` playback without a password | Task 1 (auth), Task 2 (API sends basic auth) |
| `trust proxy` 1 lets a direct caller forge `X-Forwarded-For` | Task 5 |
| Caddy's own error pages carry no security headers | Task 5 |
| `res.once('close')` after an `await` in `clips.service` | Task 2 |
| Contract polish: `openapi.json` errors, `bearerFormat`, `Point` items, `CAMERA_ID_TAKEN`, `WRONG_PASSWORD`, malformed JSON | Task 10 |
| Retire `core/api_server.py` | Task 9 |

Moved to 4b by the design: the retention indexes, demo snapshot pruning, clip byte ranges, the
`exports.controller` close race, the export file name's end date, `SiteSettings`. Still parked: the
`StreamManager` catch-up runaway (only `FILE` sources now), ANPR rebuilt synchronously, a long ONNX conversion
starving workers, the orphan ONNX file after a timed-out LPUSH, cutting a playing WebRTC stream on logout, image
publishing. Kept: downtime only for cameras with `firstSeenAt`; file sources play in real time; a MANAGER does not
see SUPERADMIN audit or login rows.

## Needs the user

1. Docker Desktop running for Testcontainers and compose.
2. Task 1: add `MEDIAMTX_PASSWORD` (and the variables the step lists) to the git-ignored `deploy/.env`.
3. Task 11: watch the API-level laptop checks, then approve pushing the branch and `contract-v0.5`.
4. The visual checks (video with boxes, debug view, stream panel) are in the frontend plan's last task.

## Not in this plan

- The frontend (Live page, `WhepPlayer`, box overlay, `StreamPanel`): the frontend plan.
- Phase 4b: `SiteSettings`, evidence pinning, retention jobs and indexes, disk warnings, `ExportJob`/BullMQ,
  Gotenberg PDF, the Exports page.
- Fake boxes from the demo feed: the demo profile has no MediaMTX and no video, so it has nothing to put boxes on.

## Review Focus

1. **A camera password or `MEDIAMTX_PASSWORD` holds `@`, `:`, `/` or `#`.** Expected: the engine's
   `rtsp://zoo:<pw>@127.0.0.1:8554/zv_<id>` parses back to user `zoo` and the exact password; the camera's own URL
   reaches MediaMTX byte for byte. Test in Task 3.
2. **Camera `gate` has a sub-stream and someone creates camera `gate_sub`.** Expected: 400, never two cameras on
   one MediaMTX path. Test in Task 2.
3. **Two tabs watch the same camera and one closes.** Expected: the other keeps getting `boxes`; when both are
   gone the API unsubscribes from `cam:{id}:boxes`. Test in Task 8.
4. **A SUPERADMIN's debug tab dies without a clean close** (laptop lid, network drop). Expected: the API stops
   refreshing `cam:{id}:debug` and unsubscribes; the key is gone within 5 s and the engine stops encoding. Test in
   Task 8.
5. **A crafted URL tries to reach MediaMTX's other endpoints through Caddy** (`/media/webrtc/v3/config/paths/list`,
   `/media/webrtc/zv_a/whep/../../v3/...`, `GET /media/webrtc/zv_a/`). Expected: 404, the Control API is never
   reachable. Checked in Task 5.

## Execution sessions

Fresh session per block (memory `model-split-and-session-cost`). Each session starts by reading this plan, the
spec, and `git log --oneline main..` to see where the last one stopped (the checkboxes are not ticked reliably;
trust git).

| Session | Tasks | Ends with |
|---|---|---|
| **A: MediaMTX and the front door** | 1–5 | paths synced, engine reading through MediaMTX, WHEP behind a session; Opus review of Tasks 2 and 5 |
| **B: boxes, debug, retire** | 6–9 | box and debug streams end to end at API level; Opus review of Task 8 |
| **C: contract and close** | 10–11 | `openapi.json`, `fe-contract.md` v0.5, laptop API checks, Opus whole-branch review, tag `contract-v0.5` (after the user's yes) |
| then the frontend plan | V1–V5 | in `zoo-analytics-web`, sessions D and E |

## Models for subagent-driven execution

| Task | Implementer | Reviewer |
|---|---|---|
| 2 path sync, 5 front door and trust proxy, 8 pub/sub relay and MJPEG | Sonnet | Opus |
| all others | Sonnet | Sonnet |
| whole branch (Task 11) | n/a | Opus |

## Target layout at the end of this plan

```
apps/api/src/mediamtx/   mediamtx.module.ts, mediamtx-client.ts, paths.ts, path-sync.service.ts,
                         stream-info.service.ts, dto/stream-info.dto.ts
apps/api/src/redis/      + pubsub.ts
apps/api/src/live/       + boxes-relay.ts
apps/api/src/media/      + debug-frames.service.ts
apps/api/src/auth/       + trusted-proxy.ts
packages/contracts/      engine/boxes.schema.json, ws/server/boxes.schema.json, ws/examples/boxes/
services/engine/core/    + boxes.py, debug_frames.py; - api_server.py
deploy/                  mediamtx.yml (auth, feed_*), compose (MediaMTX env, API env and volume, Caddy start), Caddyfile
```

---

> **Session A starts here: Tasks 1–5.**

### Task 1: MediaMTX: service password, `feed_*` test paths, Control API

**Files:**
- Modify: `deploy/mediamtx.yml`, `deploy/docker-compose.yml` (`mediamtx` service), `deploy/.env.example`,
  `deploy/.env.demo.example`
- Modify: `docs/10_LOCAL_QUICKSTART.md` (the laptop MediaMTX command and its env)

**Interfaces:**
- Produces: MediaMTX with `api: true`, `webrtc: true`, `playback: true`; one internal user `zoo` (password from the
  environment) with `read`, `playback`, `api`; anonymous `publish` from `127.0.0.1`/`::1`; anonymous `read` from
  `127.0.0.1`/`::1` only on `path: ~^feed_`. `pathDefaults`: `rtspTransport: tcp`, `record: false`,
  `recordPath` as today, `recordSegmentDuration: 10m`. `webrtcLocalUDPAddress: :8189`.
- The four test feeds become `feed_cashier`, `feed_restaurant`, `feed_gate`, `feed_horse` (same `runOnInit`, with
  the publish URL renamed).
- `.env.example` gains `MEDIAMTX_PASSWORD=change-me` (URL-safe, `openssl rand -hex 24`), and the API block's
  `ZOO_MEDIAMTX_API_URL=http://host.docker.internal:9997` (empty = no sync, no live video). `.env.demo.example`
  sets `ZOO_MEDIAMTX_API_URL=` and `ZOO_MEDIAMTX_PLAYBACK_URL=` empty.
- Compose `mediamtx` service: `MTX_AUTHINTERNALUSERS_0_PASS=${MEDIAMTX_PASSWORD:?…}` (or the fallback below) and
  `MTX_WEBRTCADDITIONALHOSTS=${ZOO_SITE_ADDRESS:-localhost}`.

- [ ] **Step 1: Write the config, then check how MediaMTX 1.21.1 takes the password**

Make `zoo` the **first** `authInternalUsers` entry with an empty `pass:`. Run natively:
`$env:MTX_AUTHINTERNALUSERS_0_PASS = "test-pass-123"; .\mediamtx.exe deploy\mediamtx.yml`.
Check: `curl.exe -u zoo:test-pass-123 http://127.0.0.1:9997/v3/config/paths/list` → 200; without `-u` → 401.
If the variable is ignored, use the fallback the spec allows: the compose service's `entrypoint` renders the file
with `sed "s/__MEDIAMTX_PASSWORD__/$MEDIAMTX_PASSWORD/"` into `/tmp/mediamtx.yml` and runs MediaMTX on it; the
quickstart gets the matching PowerShell line. Note which one worked in the commit message.

- [ ] **Step 2: Record the Control API shapes the API will rely on**

With a `feed_gate` path running and a second path added by hand
(`curl.exe -u zoo:… -X POST -H "Content-Type: application/json" -d '{"source":"rtsp://127.0.0.1:8554/feed_gate","record":true,"recordDeleteAfter":"1d"}' http://127.0.0.1:9997/v3/config/paths/add/zv_probe`),
save to the scratchpad, never to the repo: `GET /v3/config/paths/list`, `GET /v3/paths/get/zv_probe` (look for
`ready`, `tracks` or `tracks2` and its codec field, `bytesReceived`), `PATCH /v3/config/paths/patch/zv_probe`,
`DELETE /v3/config/paths/delete/zv_probe`, and the 404 body of an unknown path. Tasks 2 and 4 code against what
this shows; if a field name differs from those tasks' Interfaces, use the real one and say so in the commit.

- [ ] **Step 3: Check the auth rules**

`ffplay rtsp://127.0.0.1:8554/feed_gate` plays (anonymous, localhost, `feed_`); `ffplay
rtsp://127.0.0.1:8554/zv_probe` is refused; with `rtsp://zoo:test-pass-123@…/zv_probe` it plays.
`curl.exe "http://127.0.0.1:9996/list?path=zv_probe"` → 401; with `-u zoo:…` → 200.

- [ ] **Step 4: Commit**

```bash
git add deploy docs/10_LOCAL_QUICKSTART.md
git commit -m "feat(deploy): MediaMTX service password, feed_* test paths, Control API on, recording per path"
```

---

### Task 2: API: MediaMTX client, path derivation, reconcile

**Files:**
- Create: `apps/api/src/mediamtx/{mediamtx.module.ts,mediamtx-client.ts,paths.ts,path-sync.service.ts}`,
  `apps/api/src/mediamtx/paths.spec.ts`
- Modify: `apps/api/src/config/env.ts` (+ `env.spec.ts`), `apps/api/src/app.module.ts`,
  `apps/api/src/cameras/{cameras.module.ts,cameras.service.ts,camera-view.ts}`,
  `apps/api/src/cameras/dto/{create-camera.dto.ts,camera-fields.dto.ts}`, `apps/api/src/media/clips.service.ts`,
  `deploy/docker-compose.yml` (API env)
- Test: create `apps/api/test/path-sync.e2e-spec.ts`; extend `test/media.e2e-spec.ts`

**Interfaces:**
- Env: `MEDIAMTX_API_URL: string | undefined` (http(s) URL; empty/unset = no sync), `MEDIAMTX_PASSWORD: string |
  undefined` (required, ≥ 12 characters, when `MEDIAMTX_API_URL` is set). Clips use the same password.
- `paths.ts` (pure):
  ```ts
  export type PathConf = { source: string; rtspTransport: 'tcp'; record: boolean;
                           recordDeleteAfter: string; sourceOnDemand: boolean };
  export type CameraPaths = { main: string; sub: string | null; recorded: string | null; engine: string };
  export function mediamtxPaths(c: Pick<Camera, 'id'|'sourceType'|'subStreamUrlEnc'|'recordingEnabled'
      |'recordingStream'|'inferenceStream'>): CameraPaths | null;   // null for FILE
  export function wantedPaths(cameras: Camera[], cipher: UrlCipher): Map<string, PathConf>;  // enabled, non-FILE only
  export const isManaged = (name: string) => name.startsWith('zv_');
  ```
  `recorded` is `main` or `sub` per `recordingStream` (SUB without a sub URL → main), null when recording is off.
  `engine` likewise per `inferenceStream`. A path's `sourceOnDemand` is true when it is neither `recorded` nor
  `engine`. `recordDeleteAfter` = `${retentionDays ?? 7}d` on every path (harmless where `record` is false).
- `MediamtxClient` (`mediamtx-client.ts`): `listConfigs(): Promise<Map<string, Record<string, unknown>>>` (follows
  `pageCount`), `add(name, conf)`, `patch(name, conf)`, `remove(name)`, `pathStatus(name): Promise<… | null>`
  (null on 404). Basic auth, `AbortSignal.timeout(5000)`, `redirect: 'error'`. Errors carry status and path name,
  never a body or URL with credentials. Injected only when `MEDIAMTX_API_URL` is set (else the provider is `null`).
- `PathSync` (`path-sync.service.ts`): `request(): void` (never throws; coalesces), `reconcile(): Promise<void>`
  (public for tests). Diff: add wanted names missing in MediaMTX; patch a managed name when any `PathConf` key
  differs; delete managed names not wanted. Durations are compared as seconds, not text: MediaMTX may answer
  `recordDeleteAfter` as `72h0m0s` for the `3d` we sent (Task 1 Step 2 shows which), and a text compare would
  patch every path every 30 s. Without `MEDIAMTX_API_URL`, `request()` and `reconcile()` do nothing. On start (`onApplicationBootstrap`) it requests once; with `JOBS=on` a
  30 s interval requests too (registered like `OfflineJob`). A failed call is logged (`path zv_x: add failed
  (503)`) and the pass goes on with the next path.
- `CamerasService.create/update/remove` call `this.pathSync.request()` after the commit, next to
  `notifier.notify`.
- `CAMERA_ID_PATTERN` stays; `CreateCameraDto.id` additionally refuses a trailing `_sub` (decision 3).
- `toCameraView`: `recordingPath` comes from `mediamtxPaths(camera)?.recorded ?? null`; the stored column is not
  read. `update()` no longer writes `recordingPath`; `create()` writes null.
- `ClipsService.stream`: path from `mediamtxPaths(...)?.recorded`; sends `Authorization: Basic …` when
  `MEDIAMTX_PASSWORD` is set; the `AbortController` and `res.once('close')` move above the first `await`.
- Compose API env: `MEDIAMTX_API_URL: ${ZOO_MEDIAMTX_API_URL-http://host.docker.internal:9997}`,
  `MEDIAMTX_PASSWORD: ${MEDIAMTX_PASSWORD:-}`.

- [ ] **Step 1: Implement `paths.ts`, the client, `PathSync`, the env, the camera service hooks, the view and clips**

- [ ] **Step 2: Write the focused tests**

`paths.spec.ts`:
```ts
it('MAIN recording, SUB inference with a sub URL → main records, sub is engine, neither on demand')
it('recording off, inference MAIN, a sub URL → sub is sourceOnDemand, main is not')
it('recordingStream SUB without a sub URL → main is recorded')
it('FILE → null; disabled cameras are not in wantedPaths')
it('retentionDays null → recordDeleteAfter "7d"; 3 → "3d"')
```
`test/path-sync.e2e-spec.ts`, against a fake Control API (a `node:http` server in the test that stores paths and
records each call; `createTestApp({ MEDIAMTX_API_URL: fake.url, MEDIAMTX_PASSWORD: '…' })`):
```ts
it('creating a camera with a sub URL adds zv_<id> and zv_<id>_sub, with basic auth')
it('switching recording to SUB and retention to 3 patches both paths (record moves, recordDeleteAfter "3d")')
it('disabling deletes both paths; enabling adds them back')
it('reconcile deletes a stale zv_gone, leaves feed_gate and other_path alone')
it('a second reconcile with nothing changed sends no PATCH (the fake answers recordDeleteAfter as "72h0m0s")')
it('the fake answering 503 → the camera save still returns 200; the next reconcile() adds the path')
it('POST /cameras with id "gate_sub" → 400 VALIDATION_FAILED')
it('a FILE camera adds no path')
```
`test/media.e2e-spec.ts`: a clip request to a fake playback server carries `Authorization: Basic …` and asks
`path=zv_<id>`.

- [ ] **Step 3: Run everything**

Run: `cd apps/api && npm run lint && npm run build && npm test && npm run test:e2e`. Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api deploy/docker-compose.yml
git commit -m "feat(api): own the zv_* MediaMTX paths: derive, reconcile after each change and every 30 s"
```

---

### Task 3: API: the engine reads through MediaMTX; `liveUrls` in the camera view

**Files:**
- Modify: `apps/api/src/engine-internal/engine-cameras.service.ts`, `apps/api/src/cameras/camera-view.ts`,
  `apps/api/src/cameras/dto/camera-view.dto.ts`, every `toCameraView` caller (grep)
- Test: extend `apps/api/test/engine-internal.e2e-spec.ts`, `apps/api/src/cameras/camera-view.spec.ts`

**Interfaces:**
- Consumes: `mediamtxPaths` (Task 2), `Env.MEDIAMTX_API_URL`, `Env.MEDIAMTX_PASSWORD`.
- `EngineCamera.sourceUrl`: with MediaMTX configured and a non-`FILE` camera,
  `rtsp://zoo:${encodeURIComponent(MEDIAMTX_PASSWORD)}@127.0.0.1:8554/${paths.engine}`; otherwise the decrypted
  URL as today. The engine runs on the MediaMTX host, so `127.0.0.1:8554` is fixed (comment it).
- `toCameraView(camera, role, cipher, live: boolean)`: every role gets `liveUrls: { main: string; sub: string |
  null } | null` = `/media/webrtc/${paths.main}/whep` and the sub one, null when `!live`, `FILE` or disabled.
  `live` = `MEDIAMTX_API_URL` is set. `auditView` passes `false`. DTO: `LiveUrlsDto`, `liveUrls!: LiveUrlsDto |
  null` on the base fields.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
// engine-internal.e2e-spec.ts, app with MEDIAMTX_API_URL and MEDIAMTX_PASSWORD 'p@ss:w/rd#1-long'
it('inferenceStream SUB with a sub URL → sourceUrl ends /zv_<id>_sub and new URL(it) gives user zoo, password p@ss:w/rd#1-long')
it('inferenceStream MAIN → /zv_<id>; a FILE camera keeps its file path')
it('without MEDIAMTX_API_URL → sourceUrl is the decrypted camera URL, unchanged')
// camera-view.spec.ts
it('a USER gets liveUrls {main: "/media/webrtc/zv_cam/whep", sub: null}; FILE, disabled or live=false → null')
```

- [ ] **Step 3: Run everything** (`npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): the engine reads cameras through MediaMTX; liveUrls in the camera view"
```

---

### Task 4: API: `GET /cameras/:id/stream-info`

**Files:**
- Create: `apps/api/src/mediamtx/stream-info.service.ts`, `apps/api/src/mediamtx/dto/stream-info.dto.ts`
- Modify: `apps/api/src/cameras/cameras.controller.ts` (method `streamInfo`, operation id `camerasStreamInfo`),
  `apps/api/src/config/env.ts` (`RECORDINGS_DIR`, default `/data/recordings`), `deploy/docker-compose.yml` (API env
  `RECORDINGS_DIR: /data/recordings`, volume `${ZOO_DATA_DIR:-./data}/recordings:/data/recordings:ro`)
- Test: create `apps/api/test/stream-info.e2e-spec.ts`

**Interfaces:**
- Consumes: `MediamtxClient.pathStatus`, `mediamtxPaths`.
- `@MinRole('MANAGER') @Get(':id/stream-info')` → `StreamInfoDto`:
  ```ts
  { paths: { name: string; stream: 'MAIN' | 'SUB'; ready: boolean; recorded: boolean;
             codecs: string[]; codecWarning: 'H265_BROWSER' | null; bitrateBps: number | null;
             estimatedBytes: number | null }[];          // estimatedBytes only on the recorded path
    disk: { freeBytes: number; totalBytes: number } | null }   // statfs(RECORDINGS_DIR); null if it fails
  ```
  `codecWarning` is `H265_BROWSER` when any codec is H265/HEVC. `estimatedBytes` = `bitrateBps / 8 × 86400 ×
  (retentionDays ?? 7)`, null while bitrate is null. Bitrate per Global Constraints; the last reading per path is
  kept in a `Map` in the service. A path missing in MediaMTX → `ready: false`, empty codecs.
- No MediaMTX configured, or MediaMTX unreachable → 503 `UNAVAILABLE` (`apiError`). Unknown camera → 404. `FILE`
  camera → 200 `{paths: [], disk}`.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests** (fake MediaMTX as in Task 2, answering `paths/get`; `Date.now` moved
  with `jest.useFakeTimers({ doNotFake: [...] })` or two calls with a controlled clock helper)

```ts
it('an H265 track → codecWarning "H265_BROWSER"; H264 → null')
it('first call bitrateBps null; a second call 10 s later with +5,000,000 bytes → 4,000,000')
it('the recorded path carries estimatedBytes for retentionDays 3; the other path null')
it('a USER → 403; MediaMTX down → 503 UNAVAILABLE; no MEDIAMTX_API_URL → 503')
```

- [ ] **Step 3: Run everything**, expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api deploy/docker-compose.yml
git commit -m "feat(api): stream-info: path state, codec warning, bitrate and disk estimate"
```

---

### Task 5: Front door: `auth/check`, WHEP through Caddy, trusted proxy, error headers

**Files:**
- Create: `apps/api/src/auth/trusted-proxy.ts` (+ `trusted-proxy.spec.ts`)
- Modify: `apps/api/src/auth/auth.controller.ts` (`check`), `apps/api/src/bootstrap.ts`,
  `apps/api/src/config/env.ts` (`TRUSTED_PROXY_HOST`, default `caddy`), `deploy/caddy/Caddyfile`,
  `deploy/docker-compose.yml` (`caddy` service: `MEDIAMTX_PASSWORD`, `ZOO_MEDIAMTX_WEBRTC_UPSTREAM`, start command),
  `deploy/.env.example`, `deploy/README.md` (Ports: 8889 and UDP 8189)
- Test: extend `apps/api/test/auth.e2e-spec.ts`

**Interfaces:**
- `@Get('check') @HttpCode(204)` on `AuthController`, operation id `authCheck`: no body; 204 with a session or token
  (the global guard does the work), 401 `UNAUTHENTICATED` without. `@ApiNoContentResponse`.
- `trusted-proxy.ts`: `export function trustedProxy(host: string, lookup = dns.lookup): { trust(addr: string):
  boolean; refresh(): Promise<void>; stop(): void }`. Resolves `host` (all addresses) at start and every 60 s; a
  failed lookup keeps the last list (empty at first: nothing trusted, `req.ip` = the socket address). `configureApp`
  sets `trust proxy` to `(addr, i) => i === 0 && t.trust(addr)` (only the hop next to us may be Caddy) and stops
  the timer on shutdown. Tests and the from-source API set `TRUSTED_PROXY_HOST=127.0.0.1`.
- Caddyfile, inside `zoo_routes`, before `reverse_proxy @backend` (exact, since it is the security boundary):
  ```
  @whep {
  	path_regexp whep ^/media/webrtc/zv_[a-z0-9_]+/whep(/[0-9a-f-]+)?$
  	method OPTIONS POST PATCH DELETE
  }
  handle @whep {
  	forward_auth api:3001 {
  		uri /api/v1/auth/check
  	}
  	uri strip_prefix /media/webrtc
  	reverse_proxy {$ZOO_MEDIAMTX_WEBRTC_UPSTREAM:host.docker.internal:8889} {
  		header_up Authorization "Basic {$ZOO_MEDIAMTX_BASIC}"
  		header_down Location ^/ /media/webrtc/
  	}
  }
  respond /media/webrtc/* 404
  ```
  The API `reverse_proxy` for `@backend` gets `flush_interval -1`. A `handle_errors` block repeats the four security
  headers and answers `{err.status_code} {err.status_text}`. Place the new blocks so the existing `route` order
  holds (`/internal/*` 404 first).
- Compose `caddy`: `environment` adds `MEDIAMTX_PASSWORD` and `ZOO_MEDIAMTX_WEBRTC_UPSTREAM`; `command` per
  decision 8, ending in `exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

```ts
// auth.e2e-spec.ts
it('GET /api/v1/auth/check with a session → 204; with an API token → 204; with nothing → 401 UNAUTHENTICATED')
// TRUSTED_PROXY_HOST=127.0.0.1 (supertest connects from 127.0.0.1): the existing X-Forwarded-For login test still passes
it('TRUSTED_PROXY_HOST=10.255.255.1 → a login with X-Forwarded-For: 203.0.113.7 logs the socket address, not 203.0.113.7')
```
`trusted-proxy.spec.ts`: a fake lookup returning `['172.18.0.5']` then failing → `trust('172.18.0.5')` stays true.

- [ ] **Step 3: Check Caddy for real**

`docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` → valid. With the
dev stack up (`postgres redis api-migrate api caddy`) and native MediaMTX playing `feed_gate`, and a camera
`gate` (RTSP, `rtsp://127.0.0.1:8554/feed_gate`) created:
- `curl.exe -i -X OPTIONS http://localhost:8080/media/webrtc/zv_gate/whep` without a cookie → 401; with the session
  cookie of a USER → 204/200 from MediaMTX.
- Review Focus 5: `/media/webrtc/v3/config/paths/list`, `/media/webrtc/zv_gate/whep/../../v3/config/paths/list`,
  `GET /media/webrtc/zv_gate/` → 404 each.
- `curl.exe -i http://localhost:8080/nope-404-test` (a Caddy-made error, e.g. stop the API and ask `/api/health`)
  carries `X-Content-Type-Options: nosniff`.

- [ ] **Step 4: Run everything** (`npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api deploy
git commit -m "feat: WHEP through Caddy behind auth/check; trust only Caddy's address; security headers on Caddy errors"
```

> **Session A ends here.** Opus reviews Tasks 2 and 5 (credentials in paths and logs, the diff never touching
> non-`zv_` paths, the Caddy matcher, the trust function).

---

> **Session B starts here: Tasks 6–9.**

### Task 6: Contracts: the box payload, the `boxes` message, camera rooms

**Files:**
- Create: `packages/contracts/engine/boxes.schema.json`, `packages/contracts/ws/server/boxes.schema.json`,
  `packages/contracts/ws/examples/boxes/{valid,invalid}/*.json`, `ws/examples/subscribe/valid/camera.json`,
  `ws/examples/subscribe/invalid/camera_bad_id.json`
- Modify: `packages/contracts/ws/client/subscribe.schema.json`, `unsubscribe.schema.json`,
  `packages/contracts/scripts/generate.mjs` (collect `engine/`; Pydantic `services/engine/contracts/boxes.py`),
  `packages/contracts/README.md`, `packages/contracts/test/ws.test.mjs`
- Regenerate: `packages/contracts/generated/**`, `services/engine/contracts/**`

**Interfaces:**
- `engine/boxes.schema.json`, title `Boxes`: `{cameraId: string, t: integer (epoch ms, frame grab time), boxes:
  Box[]}`, `Box` = `{trackId: integer | null, cls: integer ≥ 0, label: string, x1, y1, x2, y2: number 0–1}`, all
  required, `additionalProperties: false`, `boxes` at most 300 items.
- `ws/server/boxes.schema.json`, title `BoxesMessage`: the same plus `sentAt: integer` (API clock, epoch ms).
  Generated `ServerToClientEvents` gains `boxes`.
- `subscribe`/`unsubscribe` `rooms` items: `anyOf: [{const: "status"}, {type: string, pattern:
  "^camera:[a-z][a-z0-9_]{2,63}$"}]`.
- Python: `from contracts.boxes import Boxes, Box`.

- [ ] **Step 1: Write the schemas and examples; extend `generate.mjs`**

- [ ] **Step 2: Generate and check**

Run: `cd packages/contracts && npm run generate && npm test && npm run check`. Expected: pass;
`generated/web/index.d.ts` has `BoxesMessage` and `boxes` in `ServerToClientEvents`.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts services/engine/contracts
git commit -m "feat(contracts): box payload, boxes WebSocket message, camera:<id> rooms"
```

---

### Task 7: Engine: publish boxes and debug frames

**Files:**
- Create: `services/engine/core/boxes.py`, `services/engine/core/debug_frames.py`,
  `services/engine/tests/test_boxes.py`, `services/engine/tests/test_debug_frames.py`
- Modify: `services/engine/core/base_pipeline.py`, the five `usecases/*/pipeline.py`, `services/engine/core/worker.py`
  (`WorkerDeps.boxes`, assigned to the pipeline like `events`), `services/engine/main.py` (start/stop both threads)

**Interfaces:**
- `BoxPublisher(threading.Thread)` (`core/boxes.py`): `__init__(redis_client)`, `offer(camera_id: str, payload:
  dict) -> None` (keeps only the latest per camera, never blocks), `stop()`. The thread `PUBLISH`es
  `cam:{id}:boxes` with the JSON; a Redis error is logged at most once a minute and the payload dropped. Its own
  client: `socket_timeout=2, socket_connect_timeout=2`.
- `BasePipeline`: class attr `boxes = None`; `run()` stores the frame's `timestamp_ms` and `(h, w)` before
  `process_frame`. `publish_boxes(self, detections: sv.Detections, labels: list[str] | None = None) -> None`:
  builds `Boxes` (Pydantic, so it matches the contract) with coordinates divided by `w`/`h` and clamped to 0–1,
  `trackId` from `detections.tracker_id` or None, `label` from `labels[i]` or `self.model.names[cls]`; no-op when
  `self.boxes` is None.
- Each pipeline calls `self.publish_boxes(detections)` once per frame: after `tracker.update_with_detections` in
  `horse_riding`, `vehicle_gate` and `restaurant_counter` (both modes, after the smoother where there is one), after
  `from_ultralytics` in `cashier_presence`, after `_suppress_duplicates` in `restaurant_table`.
- `DebugPublisher(threading.Thread)` (`core/debug_frames.py`): `__init__(redis_client, pipelines: Callable[[],
  dict[str, BasePipeline]], clock=time.monotonic)`. Once a second it pipelines `EXISTS cam:{id}:debug` for every
  camera; for a watched camera, every 0.2 s it encodes `latest_frame()` (only when `last_frame_at` changed),
  resized to at most 960 px wide, JPEG quality 70, and `PUBLISH`es the bytes to `cam:{id}:debugframes`. No key, no
  encode.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests** (Redis tests use the same fixture as `tests/test_status_redis.py`)

```python
def test_publish_boxes_normalises_and_matches_the_contract()   # 1920x1080 box → 0–1, Boxes.model_validate passes
def test_untracked_detections_get_track_id_none()
def test_box_publisher_keeps_only_the_latest_per_camera()       # offer 3 times while Redis blocks → 1 publish
def test_debug_publisher_encodes_only_while_the_key_exists()    # no key: 0 encodes; SET key: JPEG ≤ 960 wide arrives; key gone: stops
```
`tests/test_pipeline_wiring.py` (exists): each of the five pipelines calls `publish_boxes` once per `run()`.

- [ ] **Step 3: Run the engine tests**

Run: `cd services/engine && uv run pytest -q`. Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add services/engine
git commit -m "feat(engine): publish boxes per frame and debug JPEGs while a viewer is open"
```

---

### Task 8: API: box rooms and the MJPEG debug view

**Files:**
- Create: `apps/api/src/redis/pubsub.ts`, `apps/api/src/live/boxes-relay.ts`,
  `apps/api/src/media/debug-frames.service.ts`
- Modify: `apps/api/src/redis/redis.module.ts` (provide/export `RedisPubSub`), `apps/api/src/live/live.gateway.ts`
  (camera rooms in `subscribe`, ack `NOT_FOUND`), `apps/api/src/live/live.module.ts`,
  `apps/api/src/media/media.controller.ts` (`debug`), `apps/api/src/media/media.module.ts`
- Test: create `apps/api/test/boxes.e2e-spec.ts`, `apps/api/test/debug-view.e2e-spec.ts`

**Interfaces:**
- `RedisPubSub`: `subscribe(channel: string, onMessage: (data: Buffer) => void): Promise<() => Promise<void>>`.
  One duplicate connection (`maxRetriesPerRequest: null`, no `commandTimeout`, `error` listener) created on first
  use; Redis `SUBSCRIBE` on a channel's first listener, `UNSUBSCRIBE` after its last; uses `messageBuffer`. Closed on
  shutdown.
- Gateway `subscribe`: after schema validation, each `camera:<id>` room must name an existing camera
  (`prisma.camera.findUnique`), else ack `{ok: false, code: 'NOT_FOUND'}` and nothing is joined. `Ack` gains
  `'NOT_FOUND'`.
- `BoxesRelay` (`live/boxes-relay.ts`, `OnApplicationBootstrap`): listens to the socket.io adapter's `create-room`
  and `delete-room`; for a `camera:<id>` room it subscribes to / releases `cam:<id>:boxes`. Each message: parse JSON
  (drop and log at most once a minute on failure), drop if < 100 ms after the camera's last emit, else
  `server.to(room).emit('boxes', {...payload, sentAt: Date.now()})`.
- `MediaController`: `@MinRole('SUPERADMIN') @Get('debug/:id')`, `@ApiProduces('multipart/x-mixed-replace')`.
  Unknown camera → 404 (JSON, before any byte). Then `Content-Type: multipart/x-mixed-replace; boundary=frame`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and each JPEG as one part
  (`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: n\r\n\r\n<bytes>\r\n`).
- `DebugFrames` (`media/debug-frames.service.ts`): `watch(cameraId, onFrame: (jpeg: Buffer) => void): Promise<() =>
  void>`. Per camera: viewers set; first viewer → `SET cam:{id}:debug 1 EX 5` at once and every 2 s, plus
  `pubsub.subscribe('cam:{id}:debugframes')`; last viewer gone → timer cleared, subscription released (the key then
  expires). The controller releases on `res` `close` (attached before the first `await`).

- [ ] **Step 1: Implement**

- [ ] **Step 2: Write the focused tests**

`test/boxes.e2e-spec.ts` (socket.io-client as in `test/live.e2e-spec.ts`; a second Redis client publishes):
```ts
it('subscribe camera:<unknown> → {ok: false, code: "NOT_FOUND"}; camera:<id> → ok')
it('a published box set reaches the room as `boxes` with sentAt and validates against ws/server/boxes')
it('no member → PUBSUB NUMSUB cam:<id>:boxes is 0; one member → 1')
it('two sockets in the room, one disconnects → the other still receives; both gone → NUMSUB 0')   // Review Focus 3
it('20 publishes within 1 s → at most 10 boxes messages')
```
`test/debug-view.e2e-spec.ts`:
```ts
it('a MANAGER → 403; an unknown camera → 404 JSON')
it('a SUPERADMIN stream: TTL of cam:<id>:debug stays above 0 for 6 s; a published JPEG arrives as one part')
it('the client destroys the socket → within 6 s the key is gone and NUMSUB cam:<id>:debugframes is 0')   // Review Focus 4
it('two viewers, one leaves → the key is still refreshed')
```

- [ ] **Step 3: Run everything** (`npm run lint && npm run build && npm test && npm run test:e2e`), expect pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): camera rooms relay engine boxes; MJPEG debug view for superadmins"
```

---

### Task 9: Engine: retire `core/api_server.py`

**Files:**
- Delete: `services/engine/core/api_server.py`
- Modify: `services/engine/main.py`, `services/engine/core/env.py` (drop `preview_host`, `preview_port`,
  `preview_api_key` and their variables), `services/engine/tests/test_env.py`, `services/engine/pyproject.toml`
  (drop `fastapi`, `uvicorn` if `grep -rn "fastapi\|uvicorn\|starlette" services/engine tools --include=*.py` finds
  nothing else), `services/engine/uv.lock`, `services/engine/.env.example`, `services/engine/README.md`,
  comments that name `api_server.py` (`core/base_pipeline.py`, `core/snapshot_store.py`)

**Interfaces:**
- `--preview` (OpenCV windows) stays. Nothing else changes.

- [ ] **Step 1: Remove the module, the variables, the dependencies (`uv remove fastapi uvicorn`), the references**

- [ ] **Step 2: Run the engine tests**

Run: `cd services/engine && uv run pytest -q && uv run python -c "import main"`. Expected: pass;
`grep -rn "api_server\|PREVIEW_" services/engine --include=*.py --include=*.example --include=*.md` finds nothing
except `tests/test_api_client.py`'s unrelated fixture name.

- [ ] **Step 3: Commit**

```bash
git add services/engine
git commit -m "chore(engine): remove the FastAPI preview server; the dashboard reads everything from the API"
```

> **Session B ends here.** Opus reviews Task 8 (subscription reference counts, the close path, nothing leaking
> when a room or a viewer goes away mid-subscribe).

---

> **Session C starts here: Tasks 10–11.**

### Task 10: Contract polish and `openapi.json`

**Files:**
- Modify: `apps/api/src/common/errors.ts` (codes `CAMERA_ID_TAKEN`, `WRONG_PASSWORD`),
  `apps/api/src/common/error.filter.ts` (malformed JSON), `apps/api/src/cameras/cameras.service.ts` (P2002),
  `apps/api/src/auth/auth.service.ts` (wrong current password), `apps/api/src/auth/auth.controller.ts` (error
  responses), `apps/api/src/openapi/swagger.ts` (default response, `bearerFormat`),
  `packages/contracts/common/geometry.schema.json` (`Point.items`), `apps/api/openapi.json` (regenerated),
  `packages/contracts/generated/**`, `services/engine/contracts/**` (regenerated), `docs/fe-contract.md`
- Test: extend `apps/api/test/errors.e2e-spec.ts`, `apps/api/test/cameras.e2e-spec.ts`,
  `apps/api/test/auth.e2e-spec.ts`

**Interfaces:**
- `CAMERA_ID_TAKEN` 409 replaces the plain `ConflictException('Camera id already exists')`.
- A body-parser parse failure (`type === 'entity.parse.failed'`) → 400 `VALIDATION_FAILED`, message
  `Malformed JSON`, no parser text.
- Wrong current password → 400 `WRONG_PASSWORD` ("Current password is wrong").
- OpenAPI: `authLogin` documents 401, 423, 429; `authChangePassword` 400 and 429; `createOpenApiDocument` adds a
  `default` response (`ApiErrorBody`, "500 INTERNAL or 503 UNAVAILABLE") to every operation that has none. The
  bearer scheme's `bearerFormat` becomes `zv_ API token` (or is removed).
- `Point`: add `"items": {"type": "number", "minimum": 0, "maximum": 1}` next to `prefixItems`, so the web type is
  `[number, number]`; validation is unchanged (`minItems`/`maxItems` 2).
- `fe-contract.md`: new sections or paragraphs for `liveUrls`, `stream-info`, `auth/check`, `/media/webrtc/*`
  (WHEP, any logged-in user, `reader.js`), `/media/debug/:id`, the `camera:<id>` room and `boxes` (coordinates 0–1,
  `t` grab time, `sentAt`, at most 10/s, `trackId` may be null), `recordingPath` now derived; error codes table; the
  "accepted limit" that a playing stream survives logout until the page closes; section 14 `### v0.5` with one line
  per item of the spec's section 5 table, the `WRONG_PASSWORD` change marked **changed**.

- [ ] **Step 1: Implement, regenerate the contracts and `openapi.json`**

Run: `cd packages/contracts && npm run generate`; `cd apps/api && npm run openapi` (the Phase 3 script).

- [ ] **Step 2: Write the focused tests**

```ts
it('POST /cameras with an existing id → 409 CAMERA_ID_TAKEN')
it('a body of "{bad json" → 400 VALIDATION_FAILED "Malformed JSON", no "Unexpected token" in the body')
it('PUT /auth/password with a wrong current password → 400 WRONG_PASSWORD')
```

- [ ] **Step 3: Run everything**

Run: `cd packages/contracts && npm test && npm run check`; `cd apps/api && npm run lint && npm run build && npm test
&& npm run test:e2e`; `cd services/engine && uv run pytest -q`. Expected: all pass, and CI's stale-file check
(`npm run check`, the `openapi.json` diff) is clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api packages/contracts services/engine/contracts docs/fe-contract.md
git commit -m "feat(api): contract v0.5 polish: error responses, CAMERA_ID_TAKEN, WRONG_PASSWORD, typed Point"
```

---

### Task 11: Docs, the laptop checks at API level, review, `contract-v0.5`

**Files:**
- Modify: `deploy/README.md` (new section "Variables added in Phase 4a", ports, upgrading: rename hand-made paths
  to `feed_*`, old recordings are not served), `docs/10_LOCAL_QUICKSTART.md` (Phase 4a laptop run),
  `docs/fe-dev-setup.md` (no live video in the demo profile; how to run MediaMTX for it)

- [ ] **Step 1: Write the docs**

- [ ] **Step 2: Laptop run, API level** (native MediaMTX, the compose stack with `postgres redis api-migrate api
  caddy`, the engine from source on CUDA, 2–3 cameras added as `RTSP` from `feed_*`)

| Check | Pass when |
|---|---|
| Paths | `curl.exe -u zoo:… :9997/v3/config/paths/list` lists `zv_<id>` (and `_sub`) for each camera |
| Engine | the engine log shows each camera connected; `cam:<id>:status` has fps > 0 |
| Recording settings live (#8) | PATCH a camera to `recording.stream: SUB`, `retentionDays: 3` → `paths/get` shows `record` moved and `recordDeleteAfter: 72h0m0s` (or `3d`) without a MediaMTX restart; `stream-info` shows the new estimate |
| Restart | stop and start MediaMTX → `zv_*` paths back within 30 s; the engine reconnects (status fps > 0 again) |
| Boxes | `redis-cli SUBSCRIBE cam:<id>:boxes` shows messages; a socket.io client in the `camera:<id>` room gets `boxes` |
| Debug | `curl.exe -b cookie.txt http://localhost:8080/media/debug/<id> --output -` streams parts; after Ctrl+C `EXISTS cam:<id>:debug` is 0 within 5 s |
| LAN refusal | from another machine (or the laptop's LAN IP): `ffplay rtsp://<ip>:8554/zv_<id>` refused; `curl http://<ip>:9996/list?path=zv_<id>` → 401 |

Write the results into the PR description draft (scratchpad). A failure is fixed on this branch before the tag.

- [ ] **Step 3: Whole-branch review**

Dispatch an Opus reviewer over `git diff main...phase-4a-video` with the spec and this plan. Fix Critical and
Important findings; list the rest in memory `phase-4a-followups` (create it).

- [ ] **Step 4: Commit the docs and fixes**

```bash
git add deploy docs
git commit -m "docs: Phase 4a laptop run, deploy variables, MediaMTX for development"
```

- [ ] **Step 5: Tag and push (after the user's yes)**

```bash
git tag contract-v0.5
git push -u origin phase-4a-video
git push origin contract-v0.5
```

The pull request waits for the frontend plan's joint run (V5); merge with a merge commit, never a squash.
