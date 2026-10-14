# Run Zoo Vision locally (quickstart)

The shortest path from a fresh clone to the full stack running on a Windows dev laptop: MediaMTX simulates
the cameras, the engine analyses them, and the dashboard shows the events. No Docker needed.

Deployment on the park server is in [`deploy/README.md`](../deploy/README.md). That file is kept current
every phase; the full operator manual comes in Phase 5.

## What runs where

| Part | Repo / folder | Port | Talks to |
| :--- | :--- | :--- | :--- |
| MediaMTX | `zoo-vision` root, config `deploy/mediamtx.yml` | 8554 RTSP, 9996 clips | FFmpeg loops in, engine and dashboard out |
| Engine | `zoo-vision/services/engine` | 8000 (preview, snapshots) | fetches its cameras from the API and applies changes live; reads RTSP from MediaMTX; sends events to the API's Redis stream, which the API stores and pushes to the dashboard over the WebSocket (Phase 3) |
| Dashboard | `zoo-vision-fe` | 3000 | shows the engine's live preview; receives no events until Phase 3; proxies the engine API and MediaMTX clips |

## One-time setup

**Tools:** [uv](https://docs.astral.sh/uv/), [git-lfs](https://git-lfs.com/), Node.js 22, FFmpeg on `PATH`, and the
MediaMTX v1.21.1 Windows build (`mediamtx.exe`) from the [MediaMTX releases](https://github.com/bluenviron/mediamtx/releases),
saved into the `zoo-vision` repo root (it is git-ignored).

```powershell
# Backend
git clone https://github.com/Aryaputra34/zoo-vision.git
cd zoo-vision
git lfs pull                                  # sample_data/cars.mp4
python tools\fetch_models.py --dest deploy\data\models   # model weights (checksummed); the API and the engine share this folder
cd services\engine
uv sync                                       # Python 3.12 + locked dependencies in .venv
copy configs\cameras.yaml.example configs\cameras.yaml

# Dashboard (next to zoo-vision)
cd ..\..\..
git clone https://github.com/Aryaputra34/zoo-vision-fe.git
cd zoo-vision-fe
npm install
copy .env.example .env.local                  # defaults already point at 127.0.0.1:8000 and :9996
```

**Point the configs at each other.**
* `services\engine\configs\cameras.yaml` (read only by the import below): per camera, `source: rtsp://127.0.0.1:8554/<path>` and
  `recording_path: <path>`. Use the same path names as `deploy\mediamtx.yml` (`cam_cashier_01`,
  `cam_restaurant_01`, `cam_gate_entry_01`, `cam_horse_01`).
* `deploy\mediamtx.yml`: each camera path has a `runOnInit: ffmpeg ... -i "<video>"` loop. Change the four
  video paths to recordings on your machine.
* The engine reads no YAML. It gets its cameras from the API (next sections) and its static settings from
  environment variables. If you set `AI_ENGINE_API_KEY` in `.env.local`, set `PREVIEW_API_KEY` to the same
  value for the engine.

**Redis.** The Backend section below runs Redis in Compose. For a stand-alone one, start it like this. The engine sends its events, intervals and minute metrics to a Redis stream:

```powershell
docker run -d --name zoo-redis -p 6379:6379 redis:7.4.11-alpine
$env:REDIS_URL = "redis://localhost:6379/0"      # set it in the terminal that runs the engine
docker exec zoo-redis redis-cli XREVRANGE events + - COUNT 5     # the last five messages
```

Without `REDIS_URL` the engine runs but sends nothing. The dashboard (zoo-vision-fe) receives no events from
Phase 1 until Phase 3; its live preview still works, because that goes through the engine's API server.

## Backend (API, Postgres, Redis)

Phase 1 adds the NestJS API with Postgres and Redis. They run in Docker Compose; the engine still runs from source
with uv. Needs Docker Desktop. On a laptop without an NVIDIA GPU always **name the services**: a plain
`docker compose up` would also try to build and start `zoo-ai-engine` and `mediamtx`.

```powershell
cd deploy
copy .env.example .env
```

Edit `deploy\.env` and replace the five `change-me` values. Generate each one (`openssl rand -hex 24` for the three
passwords, `openssl rand -base64 32` for `CAMERA_URL_KEY`, `openssl rand -hex 32` for `ENGINE_TOKEN`; the engine
needs the same `ENGINE_TOKEN`). If port 6379 is already used by another Redis, also set
`ZOO_REDIS_PORT` (for example `6380`); the engine below must use the same port.

```powershell
docker compose up -d --build postgres redis api-migrate api caddy
docker compose ps                                  # api-migrate exited 0; postgres, redis, api healthy; caddy up
curl.exe -s http://127.0.0.1:3001/api/health       # {"status":"ok",...}
```

**Caddy.** `caddy` is the one front door: `/api`, `/media` and `/ws` go to the API, everything else to the
dashboard. On this laptop Apache holds ports 80 and 443, so add these to `deploy\.env`:

```
ZOO_HTTP_PORT=8080
ZOO_CADDY_MODE=dev
ZOO_COOKIE_SECURE=false
ZOO_WEB_UPSTREAM=host.docker.internal:3000
ZOO_SWAGGER=public
```

`http://localhost:8080/` then answers 502 until the dashboard runs (`npm run dev` on port 3000). Check the front
door with `cd apps\api; npm run smoke -- http://localhost:8080`.

**First superadmin and API token**

```powershell
docker compose exec -e ZOO_ADMIN_PASSWORD=<choose-a-password> api node dist/cli.js create-superadmin --username admin --name "Admin"
```

Open http://127.0.0.1:3001/api/docs, call `POST /api/v1/auth/login`, then `POST /api/v1/api-tokens` with
`{"name": "yaml import", "role": "SUPERADMIN"}` and copy the token (it is shown once).

**Import your YAML cameras into the API** (run again safely: existing cameras are skipped)

```powershell
cd ..
$env:ZOO_API_TOKEN = "<token>"
uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml
```

**Models.** The API and the engine share one models folder: `deploy\data\models`, which the `api` container mounts
as `/data/models`. The one-time setup already fetched the weights there. The API registers the files in that
folder only when it starts and when you call rescan, so if you fetched them after `docker compose up` (or add more
later), register them with the token from the step above:

```powershell
python tools\fetch_models.py --dest deploy\data\models      # only if the folder is empty
curl.exe -s -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:3001/api/v1/models/rescan
```

Each newly registered file gets a validation. A `.pt` or `.engine` file from elsewhere goes into
`deploy\data\models\inbox\` (copy it in completely first: a rescan moves a file that is still being copied), then
rescan. The engine below reads the same folder through `ZOO_MODELS_DIR`. `test_video.py` reads
`services\engine\models` unless you set `ZOO_MODELS_DIR` in that terminal too.

**Run the engine against the stack.** Copy the engine's env template and fill it in. `<redis-password>` and
the port come from `deploy\.env`, and `<engine-token>` is `ENGINE_TOKEN` from the same file:

```powershell
cd services\engine
copy .env.example .env          # git-ignored; edit REDIS_URL and ENGINE_TOKEN
uv run python main.py
```

The engine loads `services\engine\.env` at start. A variable already set in the terminal wins over the file,
so `$env:API_URL = "..."` still overrides it.

`ENGINE_GROUP` defaults to `default`. The engine fetches the enabled cameras of its group from the API and
refetches whenever a camera changes, so edit cameras in the API (Swagger at `/api/docs`, or the web UI later)
and the running engine follows within about a second, without reconnecting the stream. All variables are in
[`services/engine/README.md`](../services/engine/README.md).

Stop it with Ctrl+C so open intervals are closed with `engine_stop`. After a crash the next start closes them with
`engine_restart`.

**Running with an NVIDIA GPU on Windows.** By default, `pyproject.toml` pins CPU PyTorch on Windows to keep installs small (~150 MB). If your Windows machine has an NVIDIA GPU (GeForce RTX/GTX), you can enable GPU inference (40–80+ FPS):

```powershell
cd services\engine
# 1. Install CUDA PyTorch and ONNX Runtime GPU into .venv
uv pip install --reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu124
uv pip install onnxruntime-gpu

# 2. Tell uv not to auto-revert to the CPU lockfile on run
$env:UV_NO_SYNC = "1"

# 3. Clean the ~2.5 GB downloaded installer cache
uv cache clean
```

In `services/engine/.env`, set:
```dotenv
DEVICE=cuda:0
ENGINE_MAX_BATCH=4
ENGINE_MODEL_JOBS=on
```

Then run `uv run python main.py` (or `uv run --no-sync python main.py`).

**A light, single-camera run** for a weak laptop: keep one camera (here the gate camera) enabled, play a video
file through it at 1 fps, and run a small model at imgsz 640. A `FILE` source is relative to `services/engine`, and
the engine plays it in real time at the file's own frame rate, like a camera. `<token>` is the API token from the
step above; the camera ids come from `GET /api/v1/cameras`.

```powershell
$h = @{ Authorization = "Bearer <token>" }
$api = "http://127.0.0.1:3001/api/v1/cameras"
# 1. Disable every other camera (repeat for each id).
Invoke-RestMethod -Method Patch -Headers $h -ContentType "application/json" -Body '{"enabled":false}' "$api/<other id>"
# 2. Point the gate camera at the file, at 1 fps. sourceType FILE is required: the import made it MEDIAMTX, and the API refuses a non-RTSP URL for that type.
Invoke-RestMethod -Method Patch -Headers $h -ContentType "application/json" -Body '{"sourceType":"FILE","mainStreamUrl":"sample_data/cars.mp4","targetFps":1}' "$api/<gate id>"
# 3. Read its config. Note "version" and the settings.
Invoke-RestMethod -Headers $h "$api/<gate id>/config" | ConvertTo-Json -Depth 20
```

Edit the settings from step 3: `model_name` `"yolo26s.onnx"`, `imgsz` `640`, `anpr.enabled` `false`. Then save them
as a new version, with `baseVersion` set to the `version` you read (a stale one is refused with 409):

```powershell
$body = '{"baseVersion": <version>, "settings": { ...the edited settings... }, "note": "laptop run"}'
Invoke-RestMethod -Method Post -Headers $h -ContentType "application/json" -Body $body "$api/<gate id>/config"
```

On a laptop keep `ENGINE_MODEL_JOBS=off` in the engine's terminal until you need validation or conversion jobs
(they load models and use CPU). Then start the engine as above with `uv run python main.py`.

**Status.** Per camera: `online` (false when the engine has reported nothing for 15 s) and the engine's `status`
(its state, such as reconnecting, and `appliedVersion`, the config version it runs; null when offline). A frame
is at `GET /api/v1/cameras/<id>/frame`:

```powershell
curl.exe -s -H "Authorization: Bearer <token>" http://127.0.0.1:3001/api/v1/camera-status
```

The dashboard's live preview still comes from the engine on :8000, not from the API.

**Look at the data**

```powershell
cd deploy
docker compose exec postgres psql -U zoo_owner zoo_vision -c 'SELECT type, count(*) FROM "Event" GROUP BY type'
docker compose exec postgres psql -U zoo_owner zoo_vision -c 'SELECT kind, "subjectId", "start", "end", "endReason" FROM "Interval" ORDER BY "start" DESC LIMIT 10'
docker compose exec postgres psql -U zoo_owner zoo_vision -c 'SELECT count(*) FROM "DeadEvent"'   # should be 0
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning XPENDING events api'   # first number should be 0
```

Stop the stack with `docker compose stop api redis postgres`, start it again with `docker compose start postgres redis api`.
Data stays in the `pgdata` and `redisdata` volumes; `docker compose down -v` deletes it.

## Phase 3: behind Caddy on port 8080, with the demo stack next to the real engine

From Phase 3 the browser talks to one address, Caddy, which sends `/api`, `/media` and `/ws` to the API and
everything else to the dashboard. On this laptop Apache holds ports 80 and 443, so use 8080.

`deploy\.env` (next to the secrets from the Backend section):

```
ZOO_HTTP_PORT=8080
ZOO_CADDY_MODE=dev
ZOO_COOKIE_SECURE=false
ZOO_WEB_UPSTREAM=host.docker.internal:3000     # `npm run dev` of zoo-vision-fe on this machine
ZOO_SWAGGER=superadmin                         # /api/docs for a superadmin login or a superadmin API token
ZOO_DEMO=on                                    # only if you want the demo cameras and users
DEMO_PASSWORD=<at least 10 characters>
```

```powershell
cd deploy
docker compose --profile demo up -d --build postgres redis api-migrate api caddy demo-seed demo-feed
cd ..\apps\api
npm run smoke -- http://localhost:8080          # with $env:DEMO_PASSWORD set it also checks the WebSocket
```

Open http://localhost:8080 (never :3000). `demo-user`, `demo-manager` and `demo-superadmin` log in with
`DEMO_PASSWORD`; the five `demo_*` cameras are in engine group `demo`.

**The real engine next to it** (group `default`, from source on the GPU):

```powershell
cd services\engine
$env:ENGINE_GROUP = "default"
$env:DEVICE = "cuda:0"
$env:API_URL = "http://127.0.0.1:3001"          # the API's loopback port, ZOO_API_PORT
$env:ENGINE_TOKEN = "<the ENGINE_TOKEN of deploy\.env>"
$env:REDIS_URL = "redis://:<REDIS_PASSWORD>@127.0.0.1:6379/0"   # or your ZOO_REDIS_PORT
$env:SNAPSHOT_DIR = "..\..\deploy\data\snapshots"            # the folder the API serves /media/snapshots from
$env:ZOO_MODELS_DIR = "..\..\deploy\data\models"
uv run python main.py
```

Add its cameras through `POST /api/v1/cameras` (sourceType `FILE` with a path for a video file, engine group
`default`). Two cameras with the same model share one loaded instance, so GPU memory does not double; keep to 2 or
3 cameras on the 4 GB card.

## Check that it works (no cameras needed)

```powershell
cd zoo-vision\services\engine
$env:ZOO_MODELS_DIR = "..\..\deploy\data\models"                           # test_video.py needs yolo26l.onnx from here
uv run pytest                                                              # about a minute, no GPU or models needed
uv run python test_video.py --video sample_data\cars.mp4 --pipeline gate   # one pipeline in a window; q quits
```

`test_video.py` runs any pipeline on any video file (`--pipeline cashier | restaurant | restaurant_table | gate | horse`).
See [08_TESTING_GUIDE.md](08_TESTING_GUIDE.md) for every option and a command per use case.

## Run the full stack (three terminals)

| # | Folder | Command |
| :--- | :--- | :--- |
| 1 | `zoo-vision` | `.\mediamtx.exe deploy\mediamtx.yml` |
| 2 | `zoo-vision\services\engine` | `uv run python main.py` (add `--preview` for OpenCV windows), with the environment from the Backend section |
| 3 | `zoo-vision-fe` | `npm run dev`, then open http://localhost:3000 (once the dashboard is on the API, open it through Caddy at http://localhost:8080 instead: the API's cookie and the WebSocket only work there) |

Start them in this order. The MediaMTX terminal shows each camera path coming online; the engine logs
`Started N camera worker(s).`

**What to check in the dashboard:**
* `/live`: an annotated preview per camera (served by the engine on :8000).
* Use case pages and `/events`: no new events arrive in Phase 1 (the engine no longer posts to the dashboard; see
  the Phase 1 note above). Seed fake events with `npm run seed` to see these pages.
* **Bukti** (evidence) on a seeded event shows its snapshot and plays the MediaMTX clip from 15 s before to 15 s after
  (needs a minute or two of recording first).

**Dashboard only, without the engine:** `npm run seed` in `zoo-vision-fe` fills it with realistic fake events.

Stop everything with Ctrl+C in each terminal. Recordings collect in `zoo-vision\recordings\` and snapshots in
`services\engine\snapshots\`; both are git-ignored and safe to delete.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `warning: VIRTUAL_ENV=... does not match the project environment` | An old venv is still active in this terminal. Run `deactivate`; `uv` uses `services\engine\.venv`. |
| `Model 'x.onnx' not found ... Run: python tools/fetch_models.py` | Weights are missing, or `ZOO_MODELS_DIR` points at another folder. For `test_video.py`, set `$env:ZOO_MODELS_DIR = "..\..\deploy\data\models"` in that terminal (from `services\engine`). To fetch the weights, run `python tools\fetch_models.py --dest deploy\data\models` from the repo root. |
| `invalid engine environment: ...` | `REDIS_URL` or `ENGINE_TOKEN` is unset or bad; the message names each bad variable. `ENGINE_TOKEN` must equal the API's and be at least 32 characters. |
| `cars.mp4` won't open | git-lfs isn't installed, so the file is a small pointer. Install git-lfs, then `git lfs pull`. |
| A camera never connects | Its stream URL in the API differs from the MediaMTX path name, or FFmpeg can't find the video in `deploy\mediamtx.yml`. Check the MediaMTX terminal. |
| `/live` says the AI engine isn't connected | The engine isn't running, or `AI_ENGINE_API_KEY` in `.env.local` doesn't match the engine's `PREVIEW_API_KEY`. |
| "reader is too slow, discarding frames" in MediaMTX | The CPU can't keep up. Lower `targetFps` per camera in the API, or enable fewer cameras. |

More detail: [09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md](09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md) (MediaMTX and clips),
[07_INSTALLATION_GUIDE.md](07_INSTALLATION_GUIDE.md) (Linux setup, GPU, troubleshooting).
