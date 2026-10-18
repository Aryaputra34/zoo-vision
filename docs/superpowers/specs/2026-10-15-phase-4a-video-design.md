# Zoo Vision Phase 4a: live video (design)

- **Status:** approved 2026-10-15
- **Date:** 2026-10-15
- **Parent spec:** `docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`, section 6
  (phase 4) and the sections it points to: 5 (video), 7 (recording settings), 8 (tests). Phase 3's design
  (`2026-10-14-phase-3-web-on-api-design.md`) handed over the rest of the scope. This document adds the Phase 4a
  detail and records where it departs from the parent spec ("Changes to the parent spec" below).
- **Readers:** the backend developer (the project lead), who builds both the backend and the frontend of 4a, and
  the FE team, who will redesign the 4a pages later. Section 5 is the contract they build against.

## Goal

Every camera added in the web UI is pulled once by MediaMTX, recorded according to its recording settings, and
read by the engine through MediaMTX. Logged-in users watch it live over WebRTC with the engine's boxes drawn over
the video. A superadmin can open the engine's own annotated frames. Nothing on the LAN reaches video without
either a dashboard session or the MediaMTX service password.

## Phase 4 is split in two

| Part | Scope | Needs |
|---|---|---|
| **4a, live video** (this document) | MediaMTX path sync and recording settings, MediaMTX auth, WebRTC through Caddy, the box stream, the debug view, retiring `core/api_server.py`, the connection check and disk estimate | MediaMTX and the real engine on the laptop |
| **4b, evidence and exports** (own brainstorm, later) | `SiteSettings`, evidence pinning and range serving, retention jobs and the retention indexes, disk warnings, `ExportJob`/BullMQ, Gotenberg PDF, the Exports page | the demo stack is enough |

4a goes first: it holds the unknowns (WebRTC ICE, MediaMTX auth, box timing) and the security fix. 4b is designed
after 4a, because 4a sets things 4b depends on (path names, where recordings live).

## Decisions taken in the 2026-10-15 brainstorm

| # | Question | Decision |
|---|---|---|
| 1 | One Phase 4 plan or two? | **Two: 4a (live video), then 4b (evidence and exports).** |
| 2 | Who builds the Phase 4 frontend? | **The backend developer, as a working proof of concept.** The FE team redesigns it later. Phase 3's T1–T6, T8 and J1 stay with the FE team; **T7 (the Live page) moves to 4a.** |
| 3 | MediaMTX auth | **One service password** (user `zoo`, `MEDIAMTX_PASSWORD`). No anonymous read or playback from the LAN. Not MediaMTX asking the API (`authMethod: http`): with the API down the engine would lose its streams. Not JWT: too much for one park. A host firewall is added on top in the Phase 5 install script. |
| 4 | How the engine gets video | **Through MediaMTX** (`rtsp://zoo:<pw>@127.0.0.1:8554/zv_<id>`), so each camera has one connection. |
| 5 | Codec | **H.264 for anything a browser plays.** H.265 is warned about, not refused (a site may record H.265 to save disk, knowingly). |
| 6 | Boxes over the video | **Delayed to match the video and glided between engine frames** (about 100–200 ms off; good for monitoring, not frame-exact). |
| 7 | Where boxes show | **Only on the opened camera.** Grid tiles show video and status badges. |

## 1. Cameras in MediaMTX

### What the user does

Nothing changes in the camera form: a SUPERADMIN enters the camera's RTSP URL (main, and optionally sub), stored
encrypted as today. Any IP camera or NVR channel is an RTSP URL (Hikvision `/Streaming/Channels/101`, Dahua
`/cam/realmonitor?channel=1&subtype=0`, XMEye `/user=…_channel=1_stream=0.sdp`). The camera needs RTSP on, a user
account, H.264, and to be reachable from the server. Cameras that only serve MJPEG over HTTP and ONVIF discovery
are out of scope.

### Paths

The API owns every MediaMTX path whose name starts with `zv_`:

- `zv_<cameraId>`: source = the main stream URL.
- `zv_<cameraId>_sub`: source = the sub-stream URL, only when the camera has one.
- Anything else (for example the hand-written `feed_*` test feeds in `mediamtx.yml`) is never touched.

| Camera field | MediaMTX path setting |
|---|---|
| `recordingEnabled` + `recordingStream` | `record: true` on the main or the sub path, never both; `false` on the other |
| `retentionDays` (null = 7 days until `SiteSettings` arrives in 4b) | `recordDeleteAfter` on the recorded path |
| `enabled: false` | both paths stay as idle paths (`source: publisher`, no recording, same `recordDeleteAfter`): old recordings stay playable and MediaMTX still deletes them on schedule. Deleting the camera removes the paths |
| a path that is not recorded and not read by the engine | `sourceOnDemand: true`, so MediaMTX pulls it only while someone watches |

`FILE` cameras get no path: the engine reads the file directly as today, with no recording, no live video and no
clips. Video files are fed only through ffmpeg entries in the static `mediamtx.yml`, never from the UI (a
`runOnInit` command from the UI would let a superadmin login run commands on the server). On the laptop a test
camera is added as `RTSP` with `rtsp://127.0.0.1:8554/feed_<name>`, and goes through the same path as a real one.

### When the API syncs

- After the database commit of a camera create, save, enable, disable or delete.
- A reconcile loop every 30 s and once at API start: compare `GET /v3/config/paths/list` with the cameras, then
  add, patch or delete `zv_*` paths. Paths added through the Control API live only in MediaMTX's memory, so after
  a MediaMTX restart the loop puts them back within 30 s.
- A failed call is logged and retried by the next loop. It never fails the camera save: the database is the source
  of truth, MediaMTX catches up.
- The loop runs only where `JOBS=on` (one API process does it).
- `MEDIAMTX_API_URL` empty = no sync (the demo profile has no MediaMTX).

### Who reads which path

| Reader | Path |
|---|---|
| Engine | `sourceUrl` from `/internal/engine/cameras` becomes `rtsp://zoo:<pw>@127.0.0.1:8554/zv_<id>` or `…_sub`, following `inferenceStream`. `FILE` cameras keep the file path. |
| Live grid | the sub path, or the main path when there is no sub-stream |
| Opened camera | the main path |
| Clips | the recorded path. `recordingPath` is set by the API (`zv_<id>` or `zv_<id>_sub`) and no longer editable. |

Recordings made before 4a sit under the old hand-made path names, so clips of events from before 4a stop working.
There is no production data yet; accepted.

### Auth

- `deploy/mediamtx.yml`: one internal user `zoo` with the password from `MEDIAMTX_PASSWORD`, allowed `read`,
  `playback` and `api`. Anonymous `publish` stays localhost-only (ffmpeg test feeds). The anonymous private-IP
  `read`/`playback` rule goes.
- The API sends basic auth on its Control API (`:9997`) and playback (`:9996`) calls.
- The engine's RTSP URL carries the credentials. `mask_url` already hides them in logs.
- Caddy adds the `Authorization` header when it forwards WHEP (section 2).
- **First plan task:** check that MediaMTX takes the password from an environment variable
  (`MTX_AUTHINTERNALUSERS_0_PASS`). If it doesn't, the compose service renders the config file at startup instead.

### Connection check and disk estimate

`GET /api/v1/cameras/:id/stream-info` (MANAGER and up) reads MediaMTX's path status and returns, per path:
`ready`, the codec of each track, `codecWarning` (`H265_BROWSER` when a browser may not play it), and the bitrate
measured from the change in `bytesReceived` between two reads (the API keeps the last reading per path in memory).
For the recorded path it adds `estimatedBytes` (bitrate × retention days) next to `diskFreeBytes`/`diskTotalBytes`
of the recordings volume, which the API mounts read-only (`RECORDINGS_DIR`). Without MediaMTX it answers 503
`UNAVAILABLE`.

## 2. The live view

### Video through Caddy

- New Caddy route `/media/webrtc/*`: `forward_auth` to the API's `GET /api/v1/auth/check` (204 with a valid session
  or token, 401 without), then `reverse_proxy` to MediaMTX's WebRTC server (`ZOO_MEDIAMTX_WEBRTC_UPSTREAM`, default
  `host.docker.internal:8889`), with `/media/webrtc` stripped and the `zoo` basic-auth header added.
- Only the WHEP endpoints are routed: `POST /media/webrtc/zv_<…>/whep` and `PATCH`/`DELETE` on its session URL.
  Every other path under `/media/webrtc/` is a 404.
- The video itself travels from MediaMTX to the browser over UDP 8189 (ICE). MediaMTX learns the server's LAN
  address from `MTX_WEBRTCADDITIONALHOSTS`. On the laptop, `localhost` works with the native `mediamtx.exe`.
- Every logged-in role may watch.
- **Accepted limit:** a stream that is already playing keeps playing after logout or disabling until the page
  closes. The frontend closes the player on `session.ended`, so this only matters for someone deliberately keeping
  a tab open. Cutting it server-side (MediaMTX's WebRTC session kick) is parked.
- WHEP client: MediaMTX's own `reader.js` (MIT), copied into the frontend with its licence header.

### Boxes

```
engine: after tracking, per processed frame
  BasePipeline.publish_boxes(detections, labels) ──► Redis PUBLISH cam:{id}:boxes
        {cameraId, t, boxes: [{trackId, cls, label, x1, y1, x2, y2}]}   coordinates 0–1, t = frame grab time (ms)
                                                       │
API: subscribed to the channel only while the room camera:{id} has members
                                                       ▼
WebSocket room camera:{id} ──► `boxes` {…, sentAt}   at most 10 per second per camera
```

- Each of the five pipelines calls `publish_boxes` once after its tracker update. The engine always publishes;
  with no subscriber a publish costs almost nothing, and it is the feed a future Nx bridge would read.
- The Redis payload and the WebSocket message are JSON Schemas in `packages/contracts` (Pydantic for the engine,
  the web types for the frontend). Tests validate the real messages against them.
- Client → server: `subscribe {rooms: ["camera:<id>"]}`; any logged-in user. Today's ack shape is kept: an
  unknown camera answers `{ok: false, code: "NOT_FOUND"}` and joins nothing.
- Zones are drawn from the camera's config; use-case badges from the `status` room. Neither travels with boxes.

**Lining up with the video (in the browser):**
1. Clock offset to the server from `sentAt` (smoothed minimum of `receivedAt − sentAt`).
2. Video delay from WebRTC `getStats()` (jitter buffer delay per emitted frame) plus a fixed network allowance,
   smoothed over a few seconds.
3. The last ~2 s of box sets are kept. On every video frame (`requestVideoFrameCallback`) the canvas draws the
   boxes for `now − videoDelay`, in server time.
4. Between the two box sets around that moment, each box moves linearly by `trackId`; a track in only one of them
   is drawn as is.
5. A SUPERADMIN gets a manual delay slider for tuning.

### Debug view (SUPERADMIN)

- `GET /media/debug/:id` returns MJPEG (`multipart/x-mixed-replace`).
- While a response is open, the API keeps `cam:{id}:debug` alive (TTL 5 s, refreshed every 2 s) and subscribes to
  `cam:{id}:debugframes`; each JPEG received is written as one part. Several viewers share one subscription.
- An engine thread reads the debug keys of its cameras once a second. For a watched camera it encodes
  `latest_frame()` (the annotated frame the pipelines already draw for snapshots) at up to 15 per second and up to
  960 px wide, and publishes it. No key, no encoding.
- Caddy's `/media/*` route gets `flush_interval -1`, so frames are not buffered.

### Retiring `core/api_server.py`

The module, its tests, its environment variables (`preview_port`, `preview_host`, `preview_api_key`) and FastAPI and
uvicorn, if nothing else imports them, are removed. `--preview` (local OpenCV windows) stays.

## 3. The frontend (backend developer, proof of concept)

Branch `phase-4a-video` in `zoo-vision-fe`, cut from `phase-3-web-on-api` (`main` has no plumbing yet). UI text in
Indonesian, existing components, light styling; the FE team redesigns later.

| Piece | What |
|---|---|
| Live page (`/live`, was T7) | grid of sub-stream video tiles with state badges from `status.snapshot`; a tile falls back to the 2 s still from `GET /cameras/:id/frame` for `FILE` cameras or when video fails. Clicking opens the camera: main stream, box canvas, zones. SUPERADMIN: a "Debug" toggle (swaps the video for the MJPEG `<img>`) and the delay slider. |
| `src/video/` | `reader.js` (vendored), a `WhepPlayer` component, the box overlay, the pure "boxes at time t" function |
| `useCameraBoxes(cameraId)` | joins and leaves `camera:<id>` on the existing socket; a new hook next to `useLive`, which stays as it is |
| `<StreamPanel cameraId>` | standalone component showing `stream-info` (connected, codec warning, bitrate, disk estimate). Mounted in the camera form with one line after T1 is merged, or by the FE team. |

**Avoiding merge conflicts with the FE team's Phase 3 work:** 4a's frontend changes are new files, plus the Live page
(now 4a's). The generated contract files are never merged by hand: after a merge, `npm run contract:pull
contract-v0.5` rewrites them. Merge order: Phase 3's frontend into `main` (after J1), then `main` into
`phase-4a-video`, re-pull, then 4a into `main`. The FE team may stay on v0.4 or pull v0.5 at any time.

## 4. Follow-ups

**Taken into 4a** (code 4a touches anyway):
- `trust proxy` trusts only the address `caddy` resolves to (re-resolved every minute), so nobody who reaches
  `127.0.0.1:3001` or `api:3001` directly can forge `X-Forwarded-For`.
- Caddy `handle_errors` carries the security headers.
- `clips.service`: `res.once('close')` attached before the first `await`.
- The Phase 3 contract polish (section 5).

**For 4b:** the retention indexes (interval stats bounded by `end`, an index on `(kind, end)`, metric series
without `cameraIds`, `metrics.csv`); demo snapshot pruning; byte ranges for kept clips (Safari); the
`exports.controller` close race; the export file name's exclusive end date; `SiteSettings` replacing
`SITE_TIMEZONE` and the frontend's `SITE_TZ`.

**Still parked:** the `StreamManager` catch-up runaway (Phase 5 soak; only `FILE` sources now); ANPR rebuilt
synchronously (when ANPR is switched on); a long ONNX conversion starving workers (Phase 5); the orphan ONNX file
after a timed-out LPUSH (Phase 5); cutting a playing WebRTC stream on logout; image publishing (Phase 5).

**Kept:** downtime only for cameras with `firstSeenAt`; file sources play in real time; a MANAGER does not see
SUPERADMIN audit or login rows.

## 5. The contract: `contract-v0.5`

One tag at the end of 4a. Additive over v0.4 except where marked; every item gets a changelog entry in
`fe-contract.md`.

| Item | Change |
|---|---|
| `GET /api/v1/auth/check` | new: 204 / 401 `UNAUTHENTICATED` (Caddy's `forward_auth`) |
| `GET /api/v1/cameras/:id/stream-info` | new (section 1) |
| camera view | new `liveUrls: {main, sub \| null} \| null` (null for `FILE` or disabled cameras, and when the API has no MediaMTX configured, as in the demo profile); the frontend never builds MediaMTX paths |
| `recordingPath` | now set by the API; a value sent is ignored |
| `/media/webrtc/*` | new: WHEP, any logged-in user |
| `/media/debug/:id` | new: MJPEG, SUPERADMIN |
| WebSocket | new room `camera:<id>` and message `boxes` |
| `openapi.json` | error responses (`authLogin` 401/423/429, `authChangePassword` 429, a default 500/503); `bearerFormat` no longer says JWT; `Point` gets `items`, so the web type is `[number, number]` |
| error codes | new `CAMERA_ID_TAKEN` (409); malformed JSON is `VALIDATION_FAILED` without the parser's text; **changed:** a wrong current password is `WRONG_PASSWORD` instead of `BAD_REQUEST` (allowed in v0.x with the changelog entry) |

## 6. Tests and the laptop run

No test-first steps: each task ends with one focused test where the logic is risky.

| Area | What the tests prove |
|---|---|
| Path sync (API e2e, fake Control API) | create, save, disable and delete produce the right calls; the reconcile adds, patches and deletes only `zv_*`; MediaMTX down never fails a save, and the next loop catches up |
| Engine source URL | `inferenceStream` picks `zv_<id>` or `_sub` with the credentials; `FILE` keeps its path |
| `auth/check` | 204 with a session or token, 401 without |
| Boxes room | the API subscribes to Redis only while the room has members; at most 10 messages per second; messages validate against the schema |
| Debug view | refused below SUPERADMIN; the key is refreshed while open and expires after close |
| `stream-info` | codec warning and bitrate against a fake MediaMTX |
| Engine (pytest) | `publish_boxes` normalises to 0–1 and matches the schema; the debug publisher encodes only while the key exists |
| Frontend | the "boxes at time t" function (pick, glide, a track in one set only) |
| Contract | CI fails on a stale `openapi.json` or web types file, as before |

**Laptop run** (native `mediamtx.exe`, the demo profile, 2–3 cameras added as `RTSP` from `feed_*`, the engine on
CUDA):

| Parent spec verification | Check |
|---|---|
| #7 | live video with boxes over it; no video without a session; the debug view shows annotated frames and the engine stops encoding when it closes (the debug key is gone, no `debugframes` publishes) |
| #8 | switch a camera to the sub-stream and 3-day retention → applied in MediaMTX without a restart; the disk estimate updates |
| new | `:8554` and `:9996` from another LAN machine without the password are refused |
| new | restart MediaMTX → paths are back within 30 s; the engine reconnects |

Verification #7's clip half ("a warning event's clip is still playable after its segment is deleted") belongs to 4b.

## Changes to the parent spec

1. **Phase 4 is split** into 4a (live video) and 4b (evidence and exports).
2. **MediaMTX auth:** a service password (`zoo`) replaces anonymous LAN access; the parent spec did not say how
   MediaMTX itself is protected.
3. **The engine reads cameras through MediaMTX**, not directly (section 5 implied it; now explicit).
4. **MediaMTX path names are `zv_<cameraId>` and `zv_<cameraId>_sub`**, owned by the API; `recordingPath` is
   derived.
5. **`FILE` cameras have no live video, recording or clips.** Files are fed through static `mediamtx.yml` entries.
6. **The engine keeps drawing every frame** (snapshots need it); only the debug JPEG encode depends on a viewer.
   The parent spec said the engine draws only while a debug viewer is open.
7. **Boxes show on the opened camera only**, not on every grid tile.
8. **New:** `GET /auth/check`, `GET /cameras/:id/stream-info`, `liveUrls`, the codec warning.
