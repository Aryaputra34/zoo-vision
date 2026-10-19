# Frontend contract

What the dashboard may rely on from the API. This document describes **only what the tag it sits at
contains**; later tags add sections. If something here and `apps/api/openapi.json` disagree, the OpenAPI file
is right and this guide has a bug: tell the backend developer.

## 1. Versions

A contract version is a git tag `contract-vX.Y` on `Aryaputra34/zoo-vision`. At a tag, three files are the
contract:

| File | What |
|---|---|
| `apps/api/openapi.json` | Every REST endpoint, its parameters and response types. Generate your typed client from it |
| `packages/contracts/generated/web/index.d.ts` | The WebSocket message types, each use case's event, interval, settings and live types, as TypeScript, in one file with no imports |
| `docs/fe-contract.md` | This guide, with a changelog entry per tag |

In the frontend repo: `npm run contract:pull <tag | path to a local zoo-vision checkout>`. It fetches the
three files from `https://raw.githubusercontent.com/Aryaputra34/zoo-vision/<tag>/...`, then runs orval. What is
committed on the frontend's `main` always comes from a tag; a local path is for quick iteration only.

Rules: `v0.x` is Phase 3 in progress. A breaking change in `v0.x` is allowed only with a changelog entry
below. From `v1.0`, `/api/v1` changes are additive only: new optional fields, new event types, new files.

## 2. One origin

The browser talks to one address, served by Caddy:

| Path | Goes to |
|---|---|
| `/api/v1/...` | the API |
| `/media/...` | the API (snapshots and clips, from v0.2) |
| `/ws` | the API's WebSocket (from v0.3) |
| everything else | the dashboard (Next.js) |
| `/internal/*` | a 404, never routed |

- The frontend needs **no backend URL and no secret**. Call your own origin, with the paths above.
- **Never call the API from the Next.js server.** The session is a cookie in the browser; the server has none.
- In development open `http://localhost:8080` (or your `ZOO_HTTP_PORT`), not `:3000`: cookies and the WebSocket
  only work through Caddy. See `docs/fe-dev-setup.md`.

## 3. Login and roles

| Call | Answer |
|---|---|
| `POST /api/v1/auth/login` `{username, password}` | 200 `{id, username, name, role}` and a `zoo_session` cookie |
| `GET /api/v1/auth/check` | 204 with a session or API token, 401 `UNAUTHENTICATED` without (used by Caddy's `forward_auth` for WHEP) |
| `GET /api/v1/auth/me` | 200 `{type: "user" \| "token", id, name, role}` |
| `POST /api/v1/auth/logout` | 204, the cookie is cleared |
| `PUT /api/v1/auth/password` `{currentPassword, newPassword}` | 204; the user's other sessions end, this one stays |

The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`. A session slides 12 hours from the last request and ends
7 days after login at the latest. Usernames are case-insensitive. Login is limited to 10 requests a minute per
address. Five wrong passwords within 15 minutes lock the account until 15 minutes after the first of them
(`ACCOUNT_LOCKED`; the lock does not extend while it is refusing).

Three fixed roles, `SUPERADMIN` > `MANAGER` > `USER`:

| Action | USER | MANAGER | SUPERADMIN |
|---|---|---|---|
| Dashboards, live view, events, use case list, camera status and frames | yes | yes | yes |
| Camera zones, thresholds, enable or disable a camera, config versions and rollback | | yes | yes |
| Users (not superadmins), models list | | yes | yes |
| Camera source URLs, model, tracker tuning, `engineGroup`, use case, `auditCamera`, recording settings | | | yes |
| Create or delete a camera; superadmin accounts; API tokens; model upload, rescan, validate, convert, delete | | | yes |
| Read the site settings (`GET /site-settings`) | yes | yes | yes |
| Keep the clip of an event (`POST /events/:id/evidence`) | | yes | yes |
| Edit the site settings (`PATCH /site-settings`) | | | yes |

The camera field `recording.evidenceRetentionDays` is a recording setting, so only SUPERADMIN changes it. PDF jobs
(section 10) are open to every role; each user sees only their own.

**401** means there is no session (or it ended): go to `/login`. **403** means the role is too low: show the
`message`, and for `ROLE_REQUIRED` mark the fields named in `errors`. Hiding menu items is a convenience; the
API decides.

## 4. Errors

Every error has this shape:

```json
{
  "statusCode": 400,
  "code": "SETTINGS_INVALID",
  "message": "Settings are invalid",
  "errors": [{ "path": "/tripwire/start/0", "message": "must be <= 1" }]
}
```

`code` is stable: switch on it, and show `message` as a fallback. `errors` is optional. `path` is a JSON pointer
into the request body (or, for settings problems, into the settings: `/model_id`, `/tables/3/polygon`).

| Code | Status | When | What the UI does |
|---|---|---|---|
| `BAD_REQUEST` | 400 | A malformed request (bad id, an unknown use case) | Show `message` |
| `WRONG_PASSWORD` | 400 | Current password is wrong at `PUT /auth/password` | Show `message` |
| `VALIDATION_FAILED` | 400 | A body field broke a rule, or request body is malformed JSON; `errors` entries per field | Mark the fields |
| `SETTINGS_INVALID` | 400 | Settings fail their schema, or reference a model that is not READY; `errors` hold the paths | Mark the zones and fields |
| `FIELD_NOT_ALLOWED` | 400 | A `groupBy`, `max` or `where` field the requested types do not declare as the right kind (section 8) | Show `message`; it is a bug in the page |
| `RANGE_TOO_LONG` | 400 | The range is longer than its bucket allows (section 8) | Ask for a shorter range or a bigger bucket |
| `UNAUTHENTICATED` | 401 | No valid session or token (or wrong login) | Go to `/login` |
| `FORBIDDEN` | 403 | The role is too low for the route; also a disabled account at login | Show `message` |
| `ROLE_REQUIRED` | 403 | The save touches fields above the user's role; `errors` name them with `"needs SUPERADMIN"` | Disable those fields |
| `NOT_FOUND` | 404 | No such route, camera, config version, model or user | Show a not-found state |
| `RECORDING_NOT_AVAILABLE` | 404 | A clip that is gone, never recorded, or whose playback server does not answer (section 11) | Show "recording not available" |
| `CONFLICT` | 409 | The request clashes with the current state (model already registered or being converted) | Show `message` |
| `CAMERA_ID_TAKEN` | 409 | The camera id exists already on create (`POST /cameras`) | Mark the camera id field |
| `STALE_VERSION` | 409 | `baseVersion` is not the camera's active config version (someone saved first) | Offer to reload the config |
| `USERNAME_TAKEN` | 409 | A user with that username exists | Mark the username |
| `LAST_SUPERADMIN` | 409 | The change would leave no active superadmin | Show `message` |
| `CAMERA_HAS_DATA` | 409 | The camera has analytics data and cannot be deleted | Offer to disable it instead |
| `MODEL_IN_USE` | 409 | A camera uses the model | Show which cameras (`message`) |
| `ACCOUNT_LOCKED` | 423 | Five wrong passwords; `message` says how long | Show `message` |
| `TOO_LARGE` | 413 | A model upload above `MODEL_UPLOAD_MAX_BYTES` | Show the limit |
| `RATE_LIMITED` | 429 | Too many logins from one address, or too many password changes | Ask the user to wait |
| `UNAVAILABLE` | 503 | Postgres or Redis is down or too slow | Show "backend unavailable" and retry |
| `INTERNAL` | 500 | A bug; the body never carries details | Show a generic error |

`FORBIDDEN_ORIGIN` is a WebSocket `connect_error` message, not an HTTP body (section 12).

## 5. Use cases and the zone editor

`GET /api/v1/usecases` (any role) returns one entry per use case:

| Field | What |
|---|---|
| `id`, `label`, `schemaVersion` | The use case |
| `assignable` | `false` for `system`: it has no settings and cannot be given to a camera |
| `settingsSchema` | The camera settings JSON Schema, dereferenced (no `$ref`), with `default`, `x-geometry` and `x-minRole` |
| `liveSchema` | The shape of `live` in the camera status |
| `events`, `intervals`, `metrics` | What the use case reports: each event `type` and interval `kind` with its `data` schema, each metric with `label` and `unit` |

**`x-geometry`** marks what the zone editor draws on the camera's still:

| Value | Shape | Value in the settings |
|---|---|---|
| `polygon` | A closed area | An array of `[x, y]` points, at least 3 |
| `line` | A tripwire | An object `{start: [x, y], end: [x, y]}`. It sits inside its group's object, beside other fields (the horse tripwire also has `enabled`) |
| `polygon-list` | A list of items, each with its own `polygon` | An array of objects with `id`, `name` and a `polygon` (the restaurant tables) |

Coordinates are fractions of the frame, **0 to 1**, origin top left. The UI generates the `id` of a new zone or
table: `^[A-Za-z0-9_-]{1,32}$`, unique in its list, and never changed afterwards (events and intervals keep it).
Everything that is not geometry is a threshold form generated from the schema's properties.

**`x-minRole`** on a property means only that role and above may change it: show it disabled for lower roles.
The API enforces it on save (`ROLE_REQUIRED`).

## 6. Config editing

- `GET /api/v1/cameras/:id/config`: the active version `{version, useCase, schemaVersion, note, createdAt, author, settings}`.
- `GET /api/v1/cameras/:id/config/versions` (MANAGER): the history, newest first, without settings.
- `GET /api/v1/cameras/:id/config/versions/:version` (MANAGER): one version with `changes`, its differences from
  the version before (JSON pointers, `before`, `after`).
- `POST /api/v1/cameras/:id/config` (MANAGER) `{baseVersion, settings, note?, useCase?}`: saves a new version, 201
  `{version}`. `useCase` may change only for a SUPERADMIN.
- `POST /api/v1/cameras/:id/config/rollback` (MANAGER) `{baseVersion, version}`: makes an old version the new one,
  201 `{version}`.
- `PATCH /api/v1/cameras/:id` (MANAGER): camera fields. A MANAGER may change **`name`, `area` and `enabled`**; any
  other field is `ROLE_REQUIRED`. Stream URLs (`mainStreamUrl`, `subStreamUrl`) are visible, and settable, only to
  SUPERADMIN; they never appear in any other role's response.
- `recordingPath` is derived and managed by the API; any value sent in create or update payloads is ignored.
- The camera view (`GET /cameras`, `GET /cameras/:id`, `POST /cameras`, `PATCH /cameras/:id`) includes
  `liveUrls: {main, sub | null} | null` (null for `FILE` or disabled cameras, and when the API has no MediaMTX
  configured, as in the demo profile). The frontend uses these URLs directly and never builds MediaMTX paths.

**`baseVersion` and `STALE_VERSION`.** The edit form remembers the version it loaded. On save the API compares it
with the camera's active version; a mismatch is 409 `STALE_VERSION`: offer to reload, never overwrite silently.

**Saved, then Applied.** A save only stores the version and tells the engine. The engine reports back the version
it runs, as `appliedVersion`, or says why it refused, as `configError`. From v0.3 the `status` room of the
WebSocket (section 12) delivers both every 2 s: Applied when `appliedVersion` equals the saved `version`,
Rejected when `configError` is set. Without the socket, poll `GET /api/v1/cameras/:id/status` (every second or
two, for up to a minute) for the same two fields.

## 7. Camera status and frames

- `GET /api/v1/camera-status` (any role): `[{cameraId, online, status}]`, every camera by id.
- `GET /api/v1/cameras/:id/status`: `{online, status}`. `online` is false and `status` null when the engine has
  not reported in the last 15 seconds.
- `GET /api/v1/cameras/:id/frame`: the engine's latest JPEG (`image/jpeg`, `Cache-Control: no-store`). 404 until the
  first frame, and again when the engine has sent none for 10 seconds. Poll it every 2 seconds for a "live" still.
- `GET /api/v1/cameras/:id/stream-info` (MANAGER): `{running, mainStream, subStream, warning, diskEstimate}`. Reports
  whether MediaMTX paths are active, detected codecs and bitrates, any browser playback warning (e.g. H.265
  `codec_not_browser_native`), and daily disk usage estimate. 503 `UNAVAILABLE` when MediaMTX is not reachable.

`stream-info` also carries `evidenceBytes` and `evidenceCount`: the size and the number of this camera's kept clips
(section 11), for a storage line next to the recording estimate. The camera view's `recording` object gains
`evidenceRetentionDays`: how many days this camera's kept clips live, `null` for the site default.

`status` is `{state, fps, lastFrameAt, appliedVersion, configError, restarts, live, updatedAt}`; times are epoch
**milliseconds**. `live` holds the use case's current values and is typed per use case in the types file
(`vehicle_gate.VehicleGateLive`, `horse_riding.HorseRidingLive`, `cashier_presence.CashierPresenceLive`,
`restaurant_counter.RestaurantCounterLive`, `restaurant_table.RestaurantTableLive`). Every field is optional.

## 8. Reports

Three aggregate endpoints, any role. They share these parameters:

| Parameter | What |
|---|---|
| `from`, `to` | ISO 8601 **with an offset** (`2026-10-14T00:00:00+07:00` or `...Z`); `from` inclusive, `to` exclusive. Encode `+` as `%2B` in a URL (axios does). A date without an offset is `VALIDATION_FAILED` |
| `cameraIds` | Comma separated, at most 50 |
| `useCase` | One use case id |
| `bucket` | `5m`, `15m`, `hour` or `day` |

**Buckets follow the site's wall clock**, not UTC: the site time zone is `timeZone` of
`GET /api/v1/site-settings` (default `Asia/Jakarta`; a SUPERADMIN changes it there, with no restart). Load it once
after login and format every time with it. A `day` bucket starts at local midnight, an `hour` at local
`:00`. `bucketStart` is the bucket's start as a UTC string with milliseconds: for Jakarta the day of 14 October is
`2026-10-13T17:00:00.000Z`. Compare it with `new Date(...)`, do not slice the string.

**Rows are sparse**: only buckets with data come back, in `bucketStart` order. Fill the gaps in the frontend
(`fillBuckets`) so a chart shows zeros.

| Bucket | Longest range |
|---|---|
| `5m` | 2 days |
| `15m` | 7 days |
| `hour` | 31 days |
| `day` | 400 days |

Longer is `RANGE_TOO_LONG` (400). `from >= to` is `VALIDATION_FAILED`.

### `GET /api/v1/reports/events/stats`

Extra parameters: `types` (comma separated event types), `groupBy` (a comma list of `camera`, `type`, `severity`
and at most two `data.<field>`), `max` (the name of a `data` field).

```json
{ "bucket": "hour",
  "rows": [ { "bucketStart": "2026-10-14T02:00:00.000Z",
              "group": { "data.direction": "DEPARTURE" }, "count": 2 } ] }
```

- `group` has one key per `groupBy` item, spelled as requested (`camera`, `type`, `severity`, `data.direction`);
  `{}` without `groupBy`. A value is `null` where the event has none: such events form a `null` group, they are not
  dropped.
- `max` adds `max` to each row: the largest value of that `data` field in the bucket.
- A `data` field must be declared by at least one of the requested `types`: as a string or an enum for `groupBy`,
  as a number or an integer for `max`. `types` is then required. Anything else is `FIELD_NOT_ALLOWED` (400), with
  the parameter in `errors[].path`. Look the fields up in `GET /usecases` (`events[].schema.properties`).
- `system` events (`engine_started`, ...) are left out unless `useCase=system` or `types` names a system type.

### `GET /api/v1/reports/intervals/stats`

Extra parameters: `kind` (required) and `groupBy` (`camera` or `subject`).

```json
{ "bucket": "hour",
  "rows": [ { "bucketStart": "2026-10-14T03:00:00.000Z",
              "count": 1, "totalSec": 600, "avgSec": 1800, "maxSec": 1800 } ] }
```

- `count`: intervals that **start** in the bucket (and at or after `from`).
- `totalSec`: the seconds **inside** the bucket and the range. An interval that crosses a bucket edge is split: one
  starting 10:50 and ending 11:20 adds 600 s to the 10:00 bucket and 1200 s to the 11:00 bucket.
- `avgSec`, `maxSec`: the **whole** durations of the intervals that start in the bucket; `null` when none does. A
  bucket that only has the tail of an earlier interval therefore has `count: 0`, `totalSec > 0` and `null`s.
- An open interval counts up to now, or up to `to` if that is earlier.
- `groupBy=camera` adds `cameraId` to each row. `groupBy=subject` adds `cameraId` and `subjectId` (`null` for
  intervals without one): a subject id, such as a table id, is only unique within its camera.

### `GET /api/v1/reports/metrics/series`

Extra parameters: `name` (required) and **exactly one** of `agg` (`avg`, `max`, `min`) or `above` (a number); both
or neither is `VALIDATION_FAILED`.

```json
{ "bucket": "5m",
  "rows": [ { "bucketStart": "2026-10-14T05:00:00.000Z", "cameraId": "rest_1", "value": 50 } ] }
```

One row per camera and bucket. With `agg`, `value` is that aggregate of the minute values. With `above`, `value` is
the number of minutes in the bucket whose value was at or above the threshold.

### Example calls

| Page | Call |
|---|---|
| Pony Rides: departures and returns per hour today | `events/stats?types=horse_crossing&groupBy=data.direction&bucket=hour` |
| Pony Rides: the 14-day table | the same with `bucket=day` |
| Cashier: unattended minutes per hour per desk | `intervals/stats?kind=desk_unattended&groupBy=camera&bucket=hour` (divide `totalSec` by 60) |
| Cashier: the longest wait | `events/stats?types=customer_waiting&max=waitingSec&bucket=day` |
| Restaurant: the occupancy curve | `metrics/series?name=occupancy&agg=max&bucket=5m` |
| Restaurant: busy minutes | the same with `above=<warning capacity>` instead of `agg` |
| Vehicles: type by direction | `events/stats?types=vehicle_crossing&groupBy=data.vehicleType,data.direction&bucket=day` |
| Overview: alerts by severity | `events/stats?groupBy=severity&bucket=day` |

(each with `from`, `to` and `cameraIds` or `useCase`)

## 9. Lists and cursors

`GET /api/v1/events` and `GET /api/v1/intervals`, any role. Same `from`, `to`, `cameraIds` and `useCase` as the
reports (for intervals the range is on `start`), plus:

| Endpoint | Parameters |
|---|---|
| `/events` | `types`, `severity` (comma list of `info`, `warning`, `critical`), `where`, `cursor`, `limit` |
| `/intervals` | `kind`, `cursor`, `limit` |

- Newest first (`time` or `start`, then `id`, descending). `limit` is 100 by default, 500 at most (else
  `VALIDATION_FAILED`).
- The answer is `{rows, nextCursor}`. Pass `nextCursor` back as `cursor` for the next page; it is `null` on the
  last. A cursor is opaque. New rows arriving between two requests never repeat or skip a row of the pages you
  already read, because the cursor is a position, not an offset. A cursor the API did not issue is
  `VALIDATION_FAILED`.
- `where`: at most two `data.<field>:<value>` equality filters, comma separated (`data.direction:ENTRY,data.vehicleType:bus`);
  a value can not contain a comma. The fields follow the `groupBy` rule of section 8 (`types` is required): else
  `FIELD_NOT_ALLOWED`. A malformed item such as `direction:ENTRY` is `VALIDATION_FAILED`.
- System events and intervals (`engine_started`, `camera_offline`) are left out unless `useCase=system` or
  `types` / `kind` names one. Camera downtime is `GET /intervals?useCase=system&kind=camera_offline`.

An event row: `{id, time, cameraId, cameraName, useCase, type, severity, configVersion, data, snapshotUrl,
clipUrl, evidence}`. `snapshotUrl` is null when the event has no snapshot (the demo's 14 days of history have none).
`clipUrl` is null when the camera has no recording path or recording is off, unless the clip is kept; the clip
itself can still be gone (section 11). Both are paths on your own origin: use them as they are, in `<img src>` and
`<video src>`.

`evidence` is `{status, reason} | null`: the kept-clip row of the event, `null` when none exists. `status` is
`QUEUED` (the copy is not made yet, normally within a few minutes), `KEPT` (the clip is stored and plays with byte
ranges), `NO_RECORDING` (there was no recording to copy) or `FAILED` (the copy kept failing, for about 4 hours).
`reason` is `SEVERITY` (warning and critical events are kept on their own), `AUDIT_CAMERA` (every event of an audit
camera) or `USER` (someone pressed keep). A kept clip lives for the camera's `evidenceRetentionDays`, or the site's
(365 by default); its snapshot stays as long.

An interval row: `{id, cameraId, cameraName, useCase, kind, subjectId, start, end, endReason, durationSec, data}`.
`end` and `durationSec` are null while it is open.

## 10. CSV exports

`GET /api/v1/exports/events.csv`, `intervals.csv`, `metrics.csv` and `summary.csv`, any role. They take the filters
of the lists without `cursor` and `limit` (`metrics.csv`: `from`, `to`, `cameraIds`, `useCase`), and
`summary.csv` also needs `bucket=hour|day` (and has the range limits of that bucket).

Open one with a plain link or `<a download>`: the session cookie goes with it. The file is **streamed**, so a year
of data starts downloading at once and the server never holds it. If the connection breaks half way the browser
reports a failed download; a truncated file is never delivered as if it were complete.

| What | Value |
|---|---|
| Encoding | UTF-8 with a byte order mark (Excel opens it correctly), lines end in CRLF |
| Times | `YYYY-MM-DD HH:mm:ss` in the **site time zone**, not UTC |
| File name | `<kind>-<from date>-<to date>.csv`, dates in the site time zone; the last date is the last day **included** (a `to` of `2026-10-08T00:00:00+07:00` gives `...-2026-10-07.csv`) |
| A text starting with `=`, `+`, `-`, `@` | gets a leading `'`, so a spreadsheet does not run it as a formula |
| Audit | every export writes one audit row (`export.csv`) with the filters, before any data is sent |

Columns:

| File | Columns |
|---|---|
| `events.csv` | `time_local, event_id, camera_id, camera_name, use_case, type, severity, config_version`, then the event's `data`, then `snapshot_url` |
| `intervals.csv` | `start_local, end_local, duration_sec, interval_id, camera_id, camera_name, use_case, kind, subject_id, end_reason, data` |
| `metrics.csv` | `minute_local, camera_id, camera_name, use_case, name, value` |
| `summary.csv` | `bucket_local, camera_id, camera_name, use_case`, then `events.<type>.count`, `intervals.<kind>.total_sec`, `metrics.<name>.avg` and `.max` |

- `data` of `events.csv`: with a `useCase` or `types` filter, **one column `data.<field>` per property** the matching
  event schemas declare (sorted), so a Pony Rides export has `data.direction` and `data.trackerId`. Without a
  filter it is one JSON column named `data`.
- `summary.csv` has one row per camera and bucket that has data. Counts and seconds are `0` where there was
  nothing; a metric with no value is empty. The columns are those of the filtered use case, or of every use case
  but `system`. The numbers are the ones of the report endpoints.
- Row order: `events.csv` and `intervals.csv` oldest first; `metrics.csv` by camera, metric name, then minute.
- A bad filter is a normal JSON error (400) before the download starts.

### PDF summaries

A PDF is made in the background, so it has jobs. Any role; a job belongs to the user who made it, and every call
below sees only the caller's own jobs.

| Call | Answer |
|---|---|
| `POST /api/v1/exports/jobs` `{period, date, cameraIds?, useCase?}` | 202 with the job. `period` is `day`, `week` or `month`; `date` is a local date `YYYY-MM-DD` on the site time zone (the day, the first day of the week, or any day of the month); `cameraIds` at most 50 |
| `GET /api/v1/exports/jobs` | the caller's jobs, newest first, at most 50 |
| `GET /api/v1/exports/jobs/:id/file` | the PDF as an attachment (`application/pdf`, `Cache-Control: no-store`). 404 `NOT_FOUND` when the job is not finished, not the caller's, or `id` is not a uuid |

A job is `{id, params, status, error, sizeBytes, createdAt, finishedAt, fileUrl}`. `status` is `QUEUED`, `DONE`,
`FAILED` or `EXPIRED`; `fileUrl` is set when `DONE`. A queued job is picked up within seconds and takes a few
seconds to print: poll the list every 3 s while one is `QUEUED`. A failing job is retried after 1, 2 and 4 minutes,
then it is `FAILED` and `error` says why in a few words. A finished file is deleted after 7 days and the job becomes
`EXPIRED`. Without a PDF service (no Gotenberg configured), creating a job is **503 `UNAVAILABLE`**. Each created
job writes one `export.pdf` audit row.

## 11. Media

Both need the session, like every other call. They live under `/media`, outside `/api/v1`: use the URLs from the
event rows. Asking for `/api/v1/media/...` is a 404.

| Call | Answer |
|---|---|
| `GET /media/snapshots/<camera>/<date>/<event>.jpg` | `image/jpeg`, `Cache-Control: private, max-age=86400`. 404 `NOT_FOUND` when the file is missing |
| `GET /media/clips/<eventId>` | `video/mp4`, the recording from `clipBeforeSec` before the event to `clipAfterSec` after it; for a **kept** clip the stored file, with byte ranges |
| `POST /api/v1/events/<eventId>/evidence` | MANAGER and up: keep this event's clip. 200 `{eventId, status, reason}`; a repeat returns the same row, a `FAILED` or `NO_RECORDING` one is queued again. 404 `NOT_FOUND` for an unknown event, 404 `RECORDING_NOT_AVAILABLE` for an event without a camera |
| `POST /media/webrtc/<path>/whep` | WHEP session setup for WebRTC live video; forwarded to MediaMTX via Caddy `forward_auth` |
| `GET /media/debug/:id` | `multipart/x-mixed-replace`, live MJPEG stream with inference boxes, SUPERADMIN only |

- Live WebRTC playback uses the paths provided in `camera.liveUrls` (`/media/webrtc/<path>/whep`) with WHEP
  (`reader.js`). Any logged-in user can view live video. **Accepted limit:** a playing WebRTC stream survives
  logout until the page closes or the connection drops (MediaMTX manages the WebRTC peer connection).
- `/media/debug/:id` streams live MJPEG debug frames directly from the engine while open, at up to 15 per second and
  at most 960 px wide (SUPERADMIN only;
  403 `ROLE_REQUIRED` for other roles). The API refreshes a Redis key every 2 s while the response is streaming,
  and the engine stops JPEG encoding within 5 s after the viewer disconnects.
- A clip is **404 `RECORDING_NOT_AVAILABLE`** when the camera has no recording path, recording is off, the
  recording has been deleted (retention), or the playback server is not there. Show "recording not available". An
  unknown event id is `NOT_FOUND`.
- While the clip's end is still in the future (`time + clipAfterSec`), the answer is `Cache-Control: no-store`;
  afterwards `private, max-age=3600`.
- An unkept clip is generated and streamed, without byte-range support: a `<video>` element plays it, but seeking
  inside it is limited until it has been downloaded, and **Safari insists on byte ranges** and may refuse it.
  A **kept** clip (`evidence.status` `KEPT`, section 9) is a file: it answers `Range` requests with 206 and plays
  and seeks in every browser, Safari included. So only kept clips seek in Safari; for the rest offer "keep
  evidence" (`POST /events/:id/evidence`). Warning and critical events and all events of audit cameras are kept on
  their own. A kept clip is cached `private, max-age=3600`; if its file is gone the API falls back to the
  recording, then to 404.
- The demo stack has no recordings: every clip is `RECORDING_NOT_AVAILABLE`. Build that state in the UI.

## 12. WebSocket

One socket.io connection per tab, to `/ws` on your own origin. The cookie goes with it; there is no token and
no URL to configure.

```ts
import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@/contract/web';

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  path: '/ws',
  transports: ['websocket'],
});
```

`ServerToClientEvents` and `ClientToServerEvents` are in `generated/web/index.d.ts`, with every message type
(`EventCreated`, `DataChanged`, `StatusSnapshot`, `AuditNotice`, `DiskWarning`, `SessionEnded`, `Subscribe`, `Unsubscribe`).

**The rule:** the socket only says "something changed" or carries small live values. REST stays the source of
truth. There is no replay: after **every** connect or reconnect, refetch what the page shows. A missed message can
never leave a page wrong.

### Connecting

| Refused with (`connect_error.message`) | Meaning | What the UI does |
|---|---|---|
| `UNAUTHENTICATED` | No session cookie, or the session has ended. API tokens are not accepted here | Go to `/login` |
| `FORBIDDEN_ORIGIN` | The page's origin is not the socket's host (another app on the same machine) | A deployment error: show it |
| `UNAVAILABLE` | Postgres or Redis is down while the session was checked | **socket.io does not retry a refused handshake**: call `socket.connect()` again after a few seconds, with a growing delay, until it connects |

### Rooms and messages

| Room | Who | Message | When |
|---|---|---|---|
| `alerts` | everyone, joined at connect | `event.created` `{id, time, cameraId, useCase, type, severity, data, snapshotUrl}` | once per new event after an ingest commit. A commit with more than 50 new events sends none of these, only `data.changed` |
| `alerts` | everyone | `data.changed` `{cameraIds, useCases, shapes}` | after ingest commits, **at most once every 5 s**: the first change after a quiet period at once, later ones merged into one message at the end of the window. `shapes` are `event`, `interval`, `metric` |
| `status` | on request | `status.snapshot` `{at, cameras: {<id>: status \| null}}` | every 2 s while someone is in the room; `null` is an offline camera |
| `camera:<id>` | on request | `boxes` `{t, sentAt, boxes}` | up to 10/s while someone is in the room. Real-time inference boxes (coords 0–1, `t` capture ms, `sentAt` wall ms, `trackId` nullable) |
| `managers` | MANAGER and SUPERADMIN, joined at connect | `audit.notice` `{auditId, cameraId, actorName, action, time}` | a camera with `auditCamera` set was changed (section 13) |
| `managers` | MANAGER and SUPERADMIN | `disk.warning` `{path, usedPercent, freeBytes, severity, time}` | a disk used by recordings, snapshots, kept clips or exports crossed 85% (`warning`) or 95% (`critical`): once per crossing, not again until the disk falls two points below that level |
| (own sockets) | the affected user | `session.ended` `{reason}` | just before the server disconnects the socket |

Client to server: `socket.emit('subscribe', {rooms: ['status', 'camera:cam_01']}, ack)` and `unsubscribe`. Rooms
available for subscription are `status` and `camera:<id>`. The ack is `{ok: true}` or `{ok: false, code: 'VALIDATION_FAILED'}`.
Subscribing to `camera:<id>` keeps `cam:<id>:active` alive in Redis so the engine publishes boxes. Subscribe again after
a reconnect.

- `disk.warning` is for a banner: it carries the numbers, nothing to refetch. A `critical` one may be followed by
  the API deleting the oldest recordings (older than 1 hour) until the disk is under 90%; kept clips, snapshots and
  exports are never deleted for space. Nothing in the contract changes for that.
- `event.created` is for alerts (a toast, the bell). Do not build tables from it: refetch on `data.changed`.
  `data.changed` says which `cameraIds`, `useCases` and `shapes` changed so a page can ignore the rest.
- `status.snapshot` carries what `GET /cameras/:id/status` returns for every camera, so the Live tiles and
  **Saved → Applied** need no polling: a save is Applied when `appliedVersion` equals the saved `version`, Rejected
  when `configError` is set.
- If no `status.snapshot` arrives for 10 s while subscribed, show "live data paused" (Redis is down or the API is
  restarting).

### `session.ended`

The server sends it, then closes the socket. `reason`:

| Reason | Why | What the UI does |
|---|---|---|
| `logout` | The user logged out (in this tab or another with the same session) | Go to `/login` |
| `revoked` | The password was changed elsewhere, or an admin reset it | Go to `/login` |
| `disabled` | The account was disabled | Go to `/login` |
| `expired` | The session ran out (12 h idle, 7 days at most); checked every 60 s | Go to `/login` |
| `role_changed` | The role changed. **The session is still valid** | Refetch `/auth/me`, reconnect: the rooms follow the new role |

After a `session.ended` the next REST call is a 401 except for `role_changed`.

## 13. System log and audit cameras

For MANAGER and SUPERADMIN. A USER gets 403 `FORBIDDEN` on every route here.

| Route | Filters | Rows |
|---|---|---|
| `GET /api/v1/system-log/audit` | `from`, `to`, `actor`, `entity`, `action`, `auditCamera` | `{id, time, actorType, actorName, action, entity, entityId, before, after, ip, auditCamera}` |
| `GET /api/v1/system-log/logins` | `from`, `to`, `username`, `result` | `{id, time, username, userId, result, ip, userAgent}` |
| `GET /api/v1/system-log/system-events` | `from`, `to`, `types` | the event rows of section 9, always use case `system` |
| `.../audit.csv`, `.../logins.csv`, `.../system-events.csv` | the same | CSV as in section 10; each download is itself audited |

- `from` and `to` are as in section 8 (an offset is required, `to` is exclusive).
- Newest first. `limit` is 100 by default and 500 at most. For `audit` and `logins` the `id` is a number sent as a
  **string** (it is 64-bit) and `nextCursor` is the last id of the page: pass it back as `cursor`. System events
  page like the event list (section 9).
- `actor` and `username` match a part of the name, in any case. `entity`, `action` are exact (`camera`,
  `camera.create`, `camera.update`, `camera.delete`, `camera_config.save`, `camera_config.rollback`,
  `model.upload`, `user.update`, `api_token.create`, `export.csv`, ...).
  `auditCamera=true` returns only the rows about audit cameras, `false` only the others. `result` is one of
  `SUCCESS`, `WRONG_PASSWORD`, `DISABLED`, `LOCKED`, `RATE_LIMITED`, `LOGOUT`.
- `ip` is the client's address (not the proxy's). `before` and `after` are the stored JSON; passwords, tokens and
  stream URLs are redacted when the row is written.
- A MANAGER does not see what SUPERADMINs did, what was done to their accounts, or their logins (the users list
  hides them too); a SUPERADMIN sees everything.
- Camera downtime is not here: `GET /intervals?useCase=system&kind=camera_offline` (section 9).

### System events

`engine_started`, `events_dropped`, `config_rejected` (from the engine, through the event stream) and
`model_validation_failed`, which the **API** writes when an AI model fails validation:
`data {modelId, name, error}`, severity `warning`, `cameraId` null. It is **not** pushed over the WebSocket: the
System events page loads it over REST.

`disk_low` is written by the API too: `data {path, usedPercent, freeBytes}`, severity `warning` at 85% used and
`critical` at 95%, `cameraId` null; one per disk and crossing. The `managers` room gets the same numbers as
`disk.warning` (section 12); the event is the record that stays.

### Audit cameras

A camera with `auditCamera` set is one whose changes managers want to be told about. A change to it (camera
fields, config save, rollback, delete; also the change that switches the flag off) writes its audit row with
`auditCamera: true`, and the `managers` room gets one message:

```json
{ "auditId": "812", "cameraId": "cam_gate_01", "actorName": "Mira", "action": "camera_config.save",
  "time": "2026-10-14T03:15:00.123Z" }
```

as `audit.notice` (`AuditNotice` in the types file). Show a toast; `auditId` is the `id` of the audit row. Only
MANAGER and SUPERADMIN sockets are in `managers`: a USER never receives it.

## 14. Changelog

### v0.6

- New: `GET /api/v1/site-settings` (any role) and `PATCH /api/v1/site-settings` (SUPERADMIN): `{siteName, timeZone, recordingRetentionDays, snapshotRetentionDays, auditSnapshotRetentionDays, evidenceRetentionDays}`. The site time zone now comes from here; the `SITE_TIMEZONE` setting is gone.
- New: `POST /api/v1/events/:id/evidence` (MANAGER): keep an event's clip (section 11).
- Event rows: new `evidence: {status, reason} | null` (section 9); `clipUrl` stays set for a kept clip.
- New: `POST /api/v1/exports/jobs` (202), `GET /api/v1/exports/jobs`, `GET /api/v1/exports/jobs/:id/file`: PDF summaries as background jobs, statuses `QUEUED`, `DONE`, `FAILED`, `EXPIRED`, a user's own jobs only (another user's job or an id that is not a uuid is 404), 503 `UNAVAILABLE` without a PDF service, files expire after 7 days (section 10). Operation ids `exportJobsCreate`, `exportJobsList`, `exportJobsFile`.
- Camera view and save: new `recording.evidenceRetentionDays` (`null` = site default); SUPERADMIN only.
- `stream-info`: new `evidenceBytes` and `evidenceCount`.
- System events: new type `disk_low` (section 13).
- WebSocket: new message `disk.warning` in the `managers` room (section 12).
- `/media/clips/:eventId`: kept clips answer byte ranges (206); the Safari note in section 11 is rewritten: only kept clips seek in Safari.
- CSV file names: **changed:** the last date is now inclusive (`events-2026-10-01-2026-10-07.csv` for a range ending at midnight after the 7th); it was the exclusive end date.
- Debug view: the line "up to 15 frames per second" in section 11 was corrected after v0.5 went out; this tag carries the corrected text.
- Deployment: `ZOO_SITE_TIMEZONE` is removed; new `EVIDENCE_DIR`, `EXPORTS_DIR` and `ZOO_GOTENBERG_URL` (`deploy/README.md`).
- New migration `phase_4b` (`SiteSettings`, `Evidence`, `ExportJob`, `Camera.evidenceRetentionDays`; `Camera.recordingPath` dropped).
- No other breaking change to v0.5.

### v0.5

- New: `GET /api/v1/auth/check` (204 / 401 `UNAUTHENTICATED`), used by Caddy's `forward_auth` for WHEP.
- New: `GET /api/v1/cameras/:id/stream-info` for codec warnings, bitrates, and disk usage estimates.
- Camera view: new `liveUrls: {main, sub | null} | null` (null for `FILE` or disabled cameras, and when MediaMTX is unconfigured); the frontend never builds MediaMTX paths.
- `recordingPath` is now derived by the API; client-sent values on create or update are ignored.
- New media routes: `/media/webrtc/*` (WHEP WebRTC live video for any logged-in user) and `/media/debug/:id` (live MJPEG inference stream for SUPERADMIN).
- WebSocket: new room `camera:<id>` and message `boxes` (real-time bounding boxes up to 10/s per opened camera).
- `openapi.json`: error responses documented (`authLogin` 401/423/429, `authChangePassword` 400/429, default 500/503); `bearerFormat` is `zv_ API token`; `Point` schema has `items`, generating `[number, number]`.
- Error codes: new `CAMERA_ID_TAKEN` (409); malformed JSON is `VALIDATION_FAILED` without parser text; **changed:** a wrong current password at `PUT /auth/password` is `WRONG_PASSWORD` (400) instead of `BAD_REQUEST`.

### v0.4

- New: the system log (`/system-log/audit`, `/logins`, `/system-events` and their CSV), the audit camera flag on
  audit rows, the `audit.notice` message, and the `model_validation_failed` system event written by the API
  (section 13).
- `AuditLog` gains `auditCamera`; new migration `audit_camera`.
- No breaking change to v0.3.

### v0.3

- New: the WebSocket at `/ws` (section 12): rooms `alerts`, `status` and `managers`, the messages
  `event.created`, `data.changed`, `status.snapshot` and `session.ended`, session-cookie auth, an Origin check.
  `data.changed` is limited to one message per 5 s.
- New environment variables: none. New dependency of the API: `socket.io`.
- No breaking change to v0.2.

### v0.2

- New: reports (`/reports/events/stats`, `/reports/intervals/stats`, `/reports/metrics/series`), the lists
  `/events` and `/intervals` with cursors, four CSV exports under `/exports`, and `/media/snapshots/...` and
  `/media/clips/:eventId` (sections 8 to 11).
- `FIELD_NOT_ALLOWED`, `RANGE_TOO_LONG` and `RECORDING_NOT_AVAILABLE` are thrown now.
- New environment variables for the deployment: `ZOO_SITE_TIMEZONE`, `ZOO_MEDIAMTX_PLAYBACK_URL`. The snapshots
  folder is mounted read-only into the API.
- No breaking change to v0.1.

### v0.1

- One error shape with stable codes (section 4). `fields` and message arrays are gone.
- `openapi.json` is generated and typed; operation ids read `<controller><Method>` (`camerasList`, `authMe`).
- New: `GET /api/v1/usecases`, the live schemas, the WebSocket types, `model_validation_failed` in the `system`
  use case, `SWAGGER=off|superadmin|public`.
- Behind Caddy on one origin, with a demo stack that needs no GPU (`docs/fe-dev-setup.md`).
