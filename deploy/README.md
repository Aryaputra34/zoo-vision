# Deploy

Docker Compose for one park server (Ubuntu LTS + NVIDIA driver + NVIDIA Container Toolkit). Run every
command from this folder.

| Service | What it does |
|---|---|
| `postgres` | Postgres 17. Creates the `zoo_api` role on first start (`postgres/init`). No host port |
| `redis` | Redis 7.4 with a password and AOF persistence. Published on `127.0.0.1:${ZOO_REDIS_PORT:-6379}` for the host-networked engine |
| `api-migrate` | One-shot: `prisma migrate deploy` as `zoo_owner`, then exits |
| `api` | The NestJS API on `127.0.0.1:${ZOO_API_PORT}` (Swagger at `/api/docs`, see `ZOO_SWAGGER`). Serves the engine its cameras and runs the background jobs (offline check, evidence pins, retention, disk checks, PDF reports) |
| `caddy` | The only service with public ports. `/api`, `/media` and `/ws` go to the API, `/internal/*` is a 404, everything else goes to the dashboard |
| `web` | Profile `web`: the dashboard (Next.js), built from the frontend checkout `ZOO_WEB_DIR` |
| `mediamtx` | Profile `engine`: pulls each camera once, records it, re-serves RTSP to the engine, serves event clips on :9996 |
| `zoo-ai-engine` | Profile `engine`: the Python engine (`services/engine`), image `zoo-vision-engine:${ZOO_VERSION}`. Configured by environment only; gets its cameras from the API and reloads them live |

Container names are not fixed: Compose prefixes them with the project name (`zoo-vision` by default, or
`COMPOSE_PROJECT_NAME` in `.env`), so two stacks can share a server. Use `docker compose exec api ...` rather than
`docker exec <name>`.

## Upgrading a stack from before Phase 3

Phase 3 sets the Compose project name to `zoo-vision` (it was the folder name, `deploy`) and removes the fixed
container names. On the first `docker compose up` after pulling:

- **The new project has empty volumes** (`zoo-vision_pgdata`, `zoo-vision_redisdata`). The old data is not deleted:
  it stays in `deploy_pgdata` and `deploy_redisdata`. To keep using it, add `COMPOSE_PROJECT_NAME=deploy` to
  `.env` before you start. To move to the new name instead, take a backup first (see below) and restore it into
  the new stack.
- **The old containers (`zoo_api`, `zoo_postgres`, ...) keep their ports.** Run `docker compose stop` with the
  old file (or `docker stop zoo_api zoo_redis zoo_postgres`) before the first start, or the API's loopback port
  is taken.
- Caddy is new and is the only service on the public ports; set `ZOO_HTTP_PORT` and the Caddy variables in `.env`
  (see Ports and Caddy modes).

## Ports

Every host port is a variable in `.env`. Change one when the default is taken.

| Variable | Default | What |
|---|---|---|
| `ZOO_BIND_ADDR` | `0.0.0.0` | The host address Caddy's ports are published on. `127.0.0.1` keeps a development stack (public demo logins) off the LAN |
| `ZOO_HTTP_PORT` | 80 | Caddy, http. The dashboard is opened here. Caddy listens on the same number inside the container |
| `ZOO_HTTPS_PORT` | 443 | Caddy, https |
| `ZOO_API_PORT` | 3001 | The API, on `127.0.0.1` only: for the engine run from source and for debugging |
| `ZOO_REDIS_PORT` | 6379 | Redis, on `127.0.0.1` only (the host-networked engine reaches it here) |
| `ZOO_PG_PORT` | 5433 | Postgres admin access, only with `docker-compose.override.yml` |
| `ZOO_WEB_UPSTREAM` | `web:3000` | Where Caddy sends the dashboard's paths. In development: `host.docker.internal:3000` (`next dev` on the host) |
| `ZOO_MEDIAMTX_WEBRTC_UPSTREAM` | `host.docker.internal:8889` | Where Caddy sends the browser's WHEP calls (`/media/webrtc/*`, session required) |

MediaMTX and the engine use host networking, so their ports are changed in their own settings. MediaMTX
uses 8554 (RTSP), 9996 (playback), 9997 (Control API) and 8889 (WebRTC HTTP), all password-protected or
reached only through Caddy, and **UDP 8189** (WebRTC media). The browser connects to UDP 8189 directly: open
it in the server's firewall for the park's LAN and nothing wider. Without it the live view connects and then
shows no picture.

## Variables added in Phase 3

Set in `.env` (see `.env.example`); Compose passes them to the API as the variable named in the last column.

| Variable | Default | API variable | What |
|---|---|---|---|
| `COMPOSE_PROFILES` | none | | Which optional services start (see Profiles) |
| `ZOO_HTTP_PORT`, `ZOO_HTTPS_PORT`, `ZOO_API_PORT`, `ZOO_REDIS_PORT`, `ZOO_BIND_ADDR` | see Ports | | Host ports and the bind address |
| `ZOO_CADDY_MODE`, `ZOO_SITE_ADDRESS`, `ZOO_WEB_UPSTREAM`, `ZOO_WEB_DIR` | `internal-tls`, `localhost`, `web:3000`, `../../zoo-vision-fe` | | Caddy and the dashboard |
| `ZOO_COOKIE_SECURE` | `true` | `COOKIE_SECURE` | `false` only for plain http in development |
| `ZOO_SWAGGER` | `off` | `SWAGGER` | `off`, `superadmin` or `public` (development only) |
| `ZOO_MEDIAMTX_PLAYBACK_URL` | `http://host.docker.internal:9996` | `MEDIAMTX_PLAYBACK_URL` | Where the API asks MediaMTX for event clips. Set but empty: clips answer `RECORDING_NOT_AVAILABLE`. The API logs a warning when playback is unreachable |
| `ZOO_DEMO`, `DEMO_PASSWORD` | off | | Only for the demo profile (below) |
| | | `SNAPSHOT_DIR` | Fixed to `/data/snapshots` (`$ZOO_DATA_DIR/snapshots`; read-write from Phase 4b, retention deletes there) |

`INGEST` and `JOBS` (API) are unchanged and stay on in the one API container.

Two things in the API need no variable: the WebSocket at `/ws` (Caddy forwards the upgrade) and the `audit_camera`
migration, which `api-migrate` applies on the next `docker compose up -d --build api-migrate api`.

## Variables added in Phase 4a

Set in `deploy/.env` for live video and MediaMTX integration:

| Variable | Default | API variable | What |
|---|---|---|---|
| `ZOO_MEDIAMTX_CONTROL_URL` | `http://host.docker.internal:9997` | `MEDIAMTX_CONTROL_URL` | MediaMTX Control API address. Empty disables path reconciliation and stream inspection (demo profile) |
| `ZOO_MEDIAMTX_SERVICE_USER` | `zoo` | `MEDIAMTX_SERVICE_USER` | User for Control API, playback, and internal RTSP re-serving |
| `ZOO_MEDIAMTX_SERVICE_PASSWORD` | empty | `MEDIAMTX_SERVICE_PASSWORD` | Service user password (shared with MediaMTX `mediamtx.yml` and engine) |
| `ZOO_MEDIAMTX_WEBRTC_UPSTREAM` | `host.docker.internal:8889` | | Upstream for Caddy's `/media/webrtc/*` WHEP proxy (checked via `GET /api/v1/auth/check`) |
| `ZOO_MEDIAMTX_PLAYBACK_URL` | `http://host.docker.internal:9996` | `MEDIAMTX_PLAYBACK_URL` | Upstream for clip extraction |
| | | `RECORDINGS_DIR` | Fixed to `/data/recordings` (`$ZOO_DATA_DIR/recordings`; read-write from Phase 4b, retention and the free-space guard delete there) |

### Upgrading from Phase 3

- **MediaMTX path names are owned by the API:** MediaMTX creates and manages `zv_<cameraId>` and `zv_<cameraId>_sub`
  automatically via the Control API. Rename any manual test paths in `mediamtx.yml` to `feed_*` (e.g. `feed_gate`,
  `feed_cashier`).
- **Old recordings under previous manual paths are not served:** The API derives recording paths as `zv_<cameraId>`
  (or `_sub`). Clips recorded under legacy path names before Phase 4a will return `RECORDING_NOT_AVAILABLE`.
- **WHEP WebRTC playback:** The browser connects to MediaMTX's WebRTC HTTP endpoint through Caddy at
  `/media/webrtc/<path>/whep`. Ensure UDP port 8189 (or your configured WebRTC ICE UDP port) is open on the LAN firewall.

## Variables added in Phase 4b

| Variable | Default | API variable | What |
|---|---|---|---|
| | | `EVIDENCE_DIR` | Fixed to `/data/evidence` (`$ZOO_DATA_DIR/evidence`): the clips of kept events, copied there from MediaMTX |
| | | `EXPORTS_DIR` | Fixed to `/data/exports` (`$ZOO_DATA_DIR/exports`): finished PDF reports, deleted after 7 days |
| `ZOO_GOTENBERG_URL` | `http://gotenberg:3000` | `GOTENBERG_URL` | The PDF printer. Set but empty: a PDF export answers 503 `UNAVAILABLE`. Leave it unset to use the compose service |
| `ZOO_SITE_TIMEZONE` | | | **Removed.** The site name, the time zone and the retention days are in the database now: set them in the web UI (Site settings, SUPERADMIN) after upgrading. A fresh database starts with `Asia/Jakarta`, 7 days of recordings, 90 days of snapshots, 365 days of audit-camera snapshots and 365 days of kept clips. Remove the line from `.env` |

The API now writes to `$ZOO_DATA_DIR/snapshots` and `$ZOO_DATA_DIR/recordings` (they were read-only mounts): its
hourly retention job deletes expired snapshots, kept clips and export files, and the recordings of cameras that
were deleted. The engine's own snapshot pruner is switched off (`SNAPSHOT_RETENTION_DAYS=0`), so the API's setting
is the only one.

`gotenberg` (the `gotenberg/gotenberg:8.38.1` image, pinned) starts with the other services; it has no host port,
only the API reaches it. **The image is about 1.7 GB** (it carries Chromium): the first `docker compose pull` or
`up` is a large download, and the demo stack pulls it too.

### Data folder ownership (do this when upgrading)

The API runs as uid 1000 and now deletes files that MediaMTX and the engine create (`zv_<id>/` recording folders,
`<camera>/<date>/` snapshot folders). They used to run as root, so those folders could not be deleted by the API.
Compose now starts `mediamtx` and `zoo-ai-engine` as `user: "1000:1000"`. Folders that already exist are still
owned by root: once, before the first start of the new version, run

```bash
sudo chown -R 1000:1000 "$ZOO_DATA_DIR"
```

(`$ZOO_DATA_DIR` is `deploy/data` unless `.env` sets it.) **On a new server** the folders do not exist yet, and Docker
creates a missing bind-mount folder as root: create them first, or MediaMTX (uid 1000) can not write its
recordings and the engine its snapshots:

```bash
mkdir -p "$ZOO_DATA_DIR"/{models,recordings,snapshots,evidence,exports,logs}
sudo chown -R 1000:1000 "$ZOO_DATA_DIR"
```

A delete that fails with `EACCES` is counted and logged
once per pass, and the files stay. Docker Desktop on Windows and macOS ignores file ownership, so this step is for
Linux servers only.

### Disk space

- The API checks the data disk every 5 minutes. At 85% used it writes a `warning` and at 95% a `critical`
  `disk_low` event, and the managers' sockets get a `disk.warning` message (the web shows a banner).
- **Free-space guard.** At 95% used the API deletes recordings, oldest first, down to 90%. It touches only files
  under `$ZOO_DATA_DIR/recordings/zv_*` that are **older than 1 hour**; kept clips, snapshots, exports and the
  `feed_*` test paths are never deleted for space. On a small disk the recordings can therefore be shorter than the
  retention days, and a disk that fills with other data than recordings still reaches 100%: size the disk for the
  retention you set.

## The demo stack

The profile `demo` plays the engine's part for five demo cameras (one per use case, engine group `demo`) so the
frontend can be built without a GPU or a camera. It needs `ZOO_DEMO=on` and `DEMO_PASSWORD` (at least 10
characters) in `.env`; `.env.demo.example` is a complete file for it.

```bash
docker compose --profile demo up -d --build postgres redis api-migrate api caddy gotenberg demo-seed demo-feed
```

- `demo-seed` creates the five cameras and the users `demo-superadmin`, `demo-manager` and `demo-user` (all with
  `DEMO_PASSWORD`), once. It refuses to run without `ZOO_DEMO=on`.
- `demo-feed` writes 14 days of history into the `events` stream once per Redis volume (its events have no
  snapshots), then live events, intervals and metrics, `cam:<id>:status` every 5 s and a still in `cam:<id>:frame`
  every 2 s; one camera goes silent for 2 minutes every 10 minutes. It follows `cfg:changed` and reports the new
  `appliedVersion`, so Saved to Applied works. Live demo events get snapshots in `$ZOO_DATA_DIR/snapshots`
  (about 80 MB a day; the API's retention job deletes them after the site's snapshot retention days).
- The users have a **public password**: keep `ZOO_BIND_ADDR=127.0.0.1` on a machine that other people can reach.
  The demo cameras and users stay in the database they were created in (`down -v` removes them).
- It runs next to a real engine: the engine group is `default`, the demo's is `demo`, so neither runs the
  other's cameras.

## Profiles

`COMPOSE_PROFILES` in `.env` decides which optional services start. `postgres`, `redis`, `api-migrate`, `api` and
`caddy` always run.

| Profile | Adds | Use |
|---|---|---|
| `engine` | `mediamtx`, `zoo-ai-engine` | A park server (needs the NVIDIA GPU) |
| `web` | `web` | The dashboard in a container |
| `demo` | `demo-seed`, `demo-feed` | Fake cameras, users and history, no GPU (frontend development) |

A park server sets `COMPOSE_PROFILES=engine,web`. A laptop leaves it unset and names the services it wants.

## Caddy modes

`ZOO_CADDY_MODE` picks the site file in `caddy/sites/`:

| Mode | Certificate | Use |
|---|---|---|
| `dev` | none, plain http on `ZOO_HTTP_PORT` | Development. Set `ZOO_COOKIE_SECURE=false` |
| `internal-tls` (default) | Caddy's own CA signs one for `ZOO_SITE_ADDRESS` | A park server without a certificate |
| `custom-tls` | `${ZOO_DATA_DIR}/certs/cert.pem` and `key.pem` | The customer's certificate |

The API sets `COOKIE_SECURE=true` by default (`ZOO_COOKIE_SECURE`), so the login cookie needs https outside `dev`.

### Trusting the internal CA on park PCs

With `internal-tls` browsers warn until the CA's root certificate is installed once on each PC:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .
```

Copy `root.crt` to the PC and add it to the trusted root certificate authorities (Windows: double-click, Install
Certificate, Local Machine, Trusted Root Certification Authorities).

## Checking the front door

From `apps/api`: `npm run smoke -- http://localhost:8080` (use your `ZOO_HTTP_PORT`). It checks `/api/health`
through Caddy, that `/internal/engine/*` is a 404 and that the security headers are set. With
`DEMO_PASSWORD` set (the demo stack) it also logs in as `demo-user`, opens the WebSocket at `/ws` through Caddy,
subscribes to `status` and waits for a `status.snapshot`.

## First run

```bash
cp .env.example .env                                     # then replace every change-me (see Secrets)
python3 ../tools/fetch_models.py --dest ./data/models    # offline: add --from /media/usb/models
mkdir -p data/{recordings,snapshots,evidence,exports,logs}
sudo chown -R 1000:1000 data                             # see "Data folder ownership"
docker compose up -d --build
```

First create the superadmin: `docker compose exec -e ZOO_ADMIN_PASSWORD=<password> api node dist/cli.js create-superadmin --username admin --name "Admin"`.
The engine starts with no cameras. Add them through the API (or load a YAML list once with
`tools/import_yaml_config.py`, see [docs/10_LOCAL_QUICKSTART.md](../docs/10_LOCAL_QUICKSTART.md)); the running engine
picks them up within a second.

Use the same folder for `--dest` as `ZOO_DATA_DIR` in `.env`, plus `/models`. Host data lives under
`ZOO_DATA_DIR` (default `./data`, git-ignored): `recordings/`, `snapshots/`, `models/`, `logs/`.

## AI models folder

`$ZOO_DATA_DIR/models` is mounted into the `api` container as `/data/models` (`MODELS_DIR`) and into the
`zoo-ai-engine` container as `/app/models` (`ZOO_MODELS_DIR`). It is one host folder: the API registers and
validates files there, and the engine loads them and writes ONNX conversions back into it, so the engine mount is
read-write. Conversions work in a hidden `.convert-*` folder in the models root, so keep free disk space there.

| Path | What it holds |
|---|---|
| `models/*.onnx`, `*.pt`, `*.engine` | The built-in models that `fetch_models.py` downloads. Registered in place on Rescan |
| `models/inbox/` | Drop zone. Rescan moves each model file here into the registry |
| `models/registry/` | Registered files, named `<model id>.<ext>`. Uploads land here. Do not edit by hand |

The `api` container runs as uid 1000 (`node`), so give it the folder after `fetch_models.py`:
`sudo chown -R 1000:1000 "$ZOO_DATA_DIR/models"`.

The web upload accepts ONNX files only (up to `MODEL_UPLOAD_MAX_BYTES`, default 1 GiB). To add a `.pt` or
`.engine` model, copy it into `models/inbox/` and press Rescan in the models page. Copy the file in completely
first: a rescan moves a file that is still being copied. The API also rescans when it starts.

## Secrets

`.env` is git-ignored. Generate each value and never reuse one:

| Variable | Generate with |
|---|---|
| `POSTGRES_PASSWORD`, `ZOO_API_DB_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 24` (they go into connection URLs, so keep them URL-safe) |
| `CAMERA_URL_KEY` | `openssl rand -base64 32` |
| `ENGINE_TOKEN` | `openssl rand -hex 32` (at least 32 characters). One value, shared by the API and the engine; the engine sends it as a Bearer token to `/internal/engine/*` |
| `ZOO_REDIS_PORT` | optional: the host port for Redis when 6379 is taken |

> **Back up `CAMERA_URL_KEY` together with the database.** It encrypts every stored camera stream URL. If it is
> lost, all stored stream URLs become unreadable and every camera's URL must be entered again.

## Background jobs and a second engine

`JOBS` (`on` by default) switches the API's background jobs on or off: the camera offline check, the evidence pin
tick, retention, the disk and free-space checks and the PDF tick. Keep it `on` in exactly one API process; a
process with `JOBS=off` accepts keep and PDF requests that nothing there will work on.

The engine runs one camera group, set by `ENGINE_GROUP` (default `default`). An engine service for a second
group sets its own `ENGINE_GROUP` and `ENGINE_MODEL_JOBS=off`, so only one engine runs model validation and
conversion jobs. It can share the models folder and `ENGINE_TOKEN`.

## Without a GPU (laptop)

Never run a bare `docker compose up`: it would also build the GPU engine and start MediaMTX. Name the services:

```bash
docker compose up -d --build postgres redis api-migrate api gotenberg   # gotenberg: PDF reports
```

Run the engine from source against it; see [docs/10_LOCAL_QUICKSTART.md](../docs/10_LOCAL_QUICKSTART.md).
Stop: `docker compose stop api redis postgres`. Start again: `docker compose start postgres redis api`.
`docker compose down -v` also deletes the `pgdata` and `redisdata` volumes.

## Updating to a new backend version

Run from `deploy/` after `git pull`. Events keep queueing in Redis while the API restarts, so nothing is lost.

1. Compare `.env.example` with your `.env` and add any new keys.
2. Back up the database first. Migrations only go forward; going back means restoring this file and the
   previous version:
   ```bash
   docker compose exec -T postgres pg_dump -U zoo_owner -Fc -f /tmp/zoo.dump zoo_vision
   docker compose cp postgres:/tmp/zoo.dump ./zoo-$(date +%Y%m%d).dump
   ```
   In Git Bash on Windows, run `export MSYS_NO_PATHCONV=1` first; otherwise `/tmp/...` is rewritten into a
   Windows path.
3. Rebuild the API, apply new migrations and restart it:
   `docker compose up -d --build api-migrate api gotenberg`. `api-migrate` must exit 0 (`docker compose ps -a`); if it
   fails, the API does not start, and `docker compose logs api-migrate` says why.
4. If the update changed the `postgres` or `redis` services, also run `docker compose up -d postgres redis`.
   The containers are recreated; the data stays in the `pgdata` and `redisdata` volumes.
   Phase 4b only: after the `chown` step (Data folder ownership), recreate MediaMTX too, so it runs as uid 1000:
   `docker compose up -d mediamtx` (a server with the `engine` profile).
5. Engine: on a laptop, `cd services/engine && uv sync`, then restart it. On the GPU server,
   `docker compose up -d --build zoo-ai-engine`.
6. Check: `docker compose ps` (all healthy) and `curl -s http://127.0.0.1:3001/api/health`.

Restore a backup: `docker compose cp ./zoo-YYYYMMDD.dump postgres:/tmp/zoo.dump`, then
`docker compose exec postgres pg_restore -U zoo_owner -d zoo_vision --clean --if-exists /tmp/zoo.dump`.
Phase 5 adds install/update scripts, nightly backups and the offline (USB) update path.

## Database access (Navicat, psql)

Postgres publishes no port by default; the API reaches it inside the compose network. To browse it,
copy `docker-compose.override.yml.example` to `docker-compose.override.yml` (git-ignored) and run
`docker compose up -d postgres`. Postgres is then on `127.0.0.1:5433` (set `ZOO_PG_PORT` in `.env` to change
it), database `zoo_vision`, user `zoo_owner`, password `POSTGRES_PASSWORD` from `.env`.

`zoo_owner` owns the schema and can change anything, including the append-only analytics, audit and login
tables. On a park server, keep the port on 127.0.0.1 and connect through an SSH tunnel.

## Windows development

Run MediaMTX v1.21.1 locally. Download the Windows build from the MediaMTX GitHub releases into the
repo root (`mediamtx.exe` is git-ignored), then from the repo root run:

```powershell
.\mediamtx.exe deploy\mediamtx.yml
```

`mediamtx.yml` still holds the prototype's camera paths and FFmpeg test loops (Windows file paths).
Phase 4 replaces the static paths with cameras added through the web UI (MediaMTX Control API).
