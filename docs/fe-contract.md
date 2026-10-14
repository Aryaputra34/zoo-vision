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
| `GET /api/v1/auth/me` | 200 `{type: "user" \| "token", id, name, role}` |
| `POST /api/v1/auth/logout` | 204, the cookie is cleared |
| `PUT /api/v1/auth/password` `{currentPassword, newPassword}` | 204; the user's other sessions end, this one stays |

The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`. A session slides 12 hours from the last request and ends
7 days after login at the latest. Usernames are case-insensitive. Login is limited to 10 requests a minute per
address, and five wrong passwords lock the account for 15 minutes (`ACCOUNT_LOCKED`).

Three fixed roles, `SUPERADMIN` > `MANAGER` > `USER`:

| Action | USER | MANAGER | SUPERADMIN |
|---|---|---|---|
| Dashboards, live view, events, use case list, camera status and frames | yes | yes | yes |
| Camera zones, thresholds, enable or disable a camera, config versions and rollback | | yes | yes |
| Users (not superadmins), models list | | yes | yes |
| Camera source URLs, model, tracker tuning, `engineGroup`, use case, `auditCamera`, recording settings | | | yes |
| Create or delete a camera; superadmin accounts; API tokens; model upload, rescan, convert, delete | | | yes |

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
| `BAD_REQUEST` | 400 | A malformed request (bad id, unreadable JSON, an unknown use case) | Show `message` |
| `VALIDATION_FAILED` | 400 | A body field broke a rule; one `errors` entry per field | Mark the fields |
| `SETTINGS_INVALID` | 400 | Settings fail their schema, or reference a model that is not READY; `errors` hold the paths | Mark the zones and fields |
| `UNAUTHENTICATED` | 401 | No valid session or token (or wrong login) | Go to `/login` |
| `FORBIDDEN` | 403 | The role is too low for the route; also a disabled account at login | Show `message` |
| `ROLE_REQUIRED` | 403 | The save touches fields above the user's role; `errors` name them with `"needs SUPERADMIN"` | Disable those fields |
| `NOT_FOUND` | 404 | No such route, camera, config version, model or user | Show a not-found state |
| `CONFLICT` | 409 | The request clashes with the current state (camera id exists, model already registered or being converted) | Show `message` |
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

Defined but not thrown yet: `FIELD_NOT_ALLOWED` and `RANGE_TOO_LONG` (reports, v0.2),
`RECORDING_NOT_AVAILABLE` (clips, v0.2), `FORBIDDEN_ORIGIN` (the WebSocket, v0.3).

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
| `line` | A tripwire | Two `[x, y]` points |
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

**`baseVersion` and `STALE_VERSION`.** The edit form remembers the version it loaded. On save the API compares it
with the camera's active version; a mismatch is 409 `STALE_VERSION`: offer to reload, never overwrite silently.

**Saved, then Applied.** A save only stores the version and tells the engine. The engine reports back the version
it runs, as `appliedVersion`, or says why it refused, as `configError`. Until the WebSocket arrives in v0.3, poll
`GET /api/v1/cameras/:id/status` (every second or two, for up to a minute) until `status.appliedVersion` equals
the saved `version` (Applied) or `status.configError` is set (Rejected, show the text).

## 7. Camera status and frames

- `GET /api/v1/camera-status` (any role): `[{cameraId, online, status}]`, every camera by id.
- `GET /api/v1/cameras/:id/status`: `{online, status}`. `online` is false and `status` null when the engine has
  not reported in the last 15 seconds.
- `GET /api/v1/cameras/:id/frame`: the engine's latest JPEG (`image/jpeg`, `Cache-Control: no-store`). 404 until the
  first frame. Poll it every 2 seconds for a "live" still.

`status` is `{state, fps, lastFrameAt, appliedVersion, configError, restarts, live, updatedAt}`; times are epoch
**milliseconds**. `live` holds the use case's current values and is typed per use case in the types file
(`vehicle_gate.VehicleGateLive`, `horse_riding.HorseRidingLive`, `cashier_presence.CashierPresenceLive`,
`restaurant_counter.RestaurantCounterLive`, `restaurant_table.RestaurantTableLive`). Every field is optional.

## 8. WebSocket types

The message types are already in `generated/web/index.d.ts`: `EventCreated`, `DataChanged`, `StatusSnapshot`,
`CameraStatus`, `AuditNotice`, `SessionEnded`, `Subscribe`, `Unsubscribe`, and the socket.io event maps
`ServerToClientEvents` and `ClientToServerEvents`. The gateway itself arrives in v0.3, so build against the
types and poll as described in section 6 until then.

## 9. Changelog

### v0.1

- One error shape with stable codes (section 4). `fields` and message arrays are gone.
- `openapi.json` is generated and typed; operation ids read `<controller><Method>` (`camerasList`, `authMe`).
- New: `GET /api/v1/usecases`, the live schemas, the WebSocket types, `model_validation_failed` in the `system`
  use case, `SWAGGER=off|superadmin|public`.
- Behind Caddy on one origin, with a demo stack that needs no GPU (`docs/fe-dev-setup.md`).
