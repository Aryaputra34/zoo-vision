# Run Zoo Vision locally (quickstart)

The shortest path from a fresh clone to the full stack running on a Windows dev laptop: MediaMTX simulates
the cameras, the engine analyses them, and the dashboard shows the events. No Docker needed.

Deployment on the park server is in [`deploy/README.md`](../deploy/README.md). That file is kept current
every phase; the full operator manual comes in Phase 5.

## What runs where

| Part | Repo / folder | Port | Talks to |
| :--- | :--- | :--- | :--- |
| MediaMTX | `zoo-vision` root, config `deploy/mediamtx.yml` | 8554 RTSP, 9996 clips | FFmpeg loops in, engine and dashboard out |
| Engine | `zoo-vision/services/engine` | 8000 (preview, snapshots) | reads RTSP from MediaMTX, posts events to the dashboard |
| Dashboard | `zoo-vision-fe` | 3000 | receives events, proxies the engine API and MediaMTX clips |

## One-time setup

**Tools:** [uv](https://docs.astral.sh/uv/), [git-lfs](https://git-lfs.com/), Node.js 22, FFmpeg on `PATH`, and the
MediaMTX v1.21.1 Windows build (`mediamtx.exe`) from the [MediaMTX releases](https://github.com/bluenviron/mediamtx/releases),
saved into the `zoo-vision` repo root (it is git-ignored).

```powershell
# Backend
git clone https://github.com/Aryaputra34/zoo-vision.git
cd zoo-vision
git lfs pull                                  # sample_data/cars.mp4
python tools\fetch_models.py                  # model weights → services\engine\models\ (checksummed)
cd services\engine
uv sync                                       # Python 3.12 + locked dependencies in .venv
copy configs\cameras.yaml.example configs\cameras.yaml
copy configs\app_config.yaml.example configs\app_config.yaml

# Dashboard (next to zoo-vision)
cd ..\..\..
git clone https://github.com/Aryaputra34/zoo-vision-fe.git
cd zoo-vision-fe
npm install
copy .env.example .env.local                  # defaults already point at 127.0.0.1:8000 and :9996
```

**Point the configs at each other.**
* `services\engine\configs\cameras.yaml`: per camera, `source: rtsp://127.0.0.1:8554/<path>` and
  `recording_path: <path>`. Use the same path names as `deploy\mediamtx.yml` (`cam_cashier_01`,
  `cam_restaurant_01`, `cam_gate_entry_01`, `cam_horse_01`).
* `deploy\mediamtx.yml`: each camera path has a `runOnInit: ffmpeg ... -i "<video>"` loop. Change the four
  video paths to recordings on your machine.
* `services\engine\configs\app_config.yaml`: `analytics.enabled: true` and
  `api_url: http://localhost:3000/api/events` (the defaults). If you set `INGEST_API_KEY` or
  `AI_ENGINE_API_KEY` in `.env.local`, put the same values in `analytics.api_key` and `api_server.api_key`.

## Check that it works (no cameras needed)

```powershell
cd zoo-vision\services\engine
uv run pytest                                                              # about a minute, no GPU or models needed
uv run python test_video.py --video sample_data\cars.mp4 --pipeline gate   # one pipeline in a window; q quits
```

`test_video.py` runs any pipeline on any video file (`--pipeline cashier | restaurant | restaurant_table | gate | horse`).
See [08_TESTING_GUIDE.md](08_TESTING_GUIDE.md) for every option and a command per use case.

## Run the full stack (three terminals)

| # | Folder | Command |
| :--- | :--- | :--- |
| 1 | `zoo-vision` | `.\mediamtx.exe deploy\mediamtx.yml` |
| 2 | `zoo-vision\services\engine` | `uv run python main.py` (add `--preview` for OpenCV windows) |
| 3 | `zoo-vision-fe` | `npm run dev`, then open http://localhost:3000 |

Start them in this order. The MediaMTX terminal shows each camera path coming online; the engine logs
`Started N camera worker(s).`

**What to check in the dashboard:**
* `/live`: an annotated preview per camera (served by the engine on :8000).
* Use case pages and `/events`: new events arrive with a snapshot.
* **Bukti** (evidence) on an event shows its snapshot and plays the MediaMTX clip from 15 s before to 15 s after
  (needs a minute or two of recording first).

**Dashboard only, without the engine:** `npm run seed` in `zoo-vision-fe` fills it with realistic fake events.

Stop everything with Ctrl+C in each terminal. Recordings collect in `zoo-vision\recordings\` and snapshots in
`services\engine\snapshots\`; both are git-ignored and safe to delete.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `warning: VIRTUAL_ENV=... does not match the project environment` | An old venv is still active in this terminal. Run `deactivate`; `uv` uses `services\engine\.venv`. |
| `Model 'x.onnx' not found ... Run: python tools/fetch_models.py` | Weights are missing. Run `python tools\fetch_models.py` from the repo root. A missing `.onnx` stops the whole engine at startup. |
| `cars.mp4` won't open | git-lfs isn't installed, so the file is a small pointer. Install git-lfs, then `git lfs pull`. |
| A camera never connects | Its MediaMTX path name differs from the one in `cameras.yaml`, or FFmpeg can't find the video in `deploy\mediamtx.yml`. Check the MediaMTX terminal. |
| `/live` says the AI engine isn't connected | The engine isn't running, or `AI_ENGINE_URL` / `AI_ENGINE_API_KEY` in `.env.local` don't match `api_server` in `app_config.yaml`. |
| `test_synthetic_demo.py` fails with a CUDA error | It is hard-coded to `cuda:0`. On a laptop without an NVIDIA GPU, use `uv run pytest` instead. |
| "reader is too slow, discarding frames" in MediaMTX | The CPU can't keep up. Lower `target_fps` per camera in `cameras.yaml`, or enable fewer cameras. |

More detail: [09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md](09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md) (MediaMTX and clips),
[07_INSTALLATION_GUIDE.md](07_INSTALLATION_GUIDE.md) (Linux setup, GPU, troubleshooting).
