# Deploy

Docker Compose for one park server (Ubuntu LTS + NVIDIA driver + NVIDIA Container Toolkit). Run every
command from this folder.

| Service | What it does |
|---|---|
| `mediamtx` | Pulls each camera once, records it, re-serves RTSP to the engine, serves event clips on :9996 |
| `zoo-ai-engine` | The Python engine (`services/engine`), image `zoo-vision-engine:${ZOO_VERSION}` |

## First run

```bash
cp .env.example .env                                     # ZOO_DATA_DIR, ZOO_VERSION
python3 ../tools/fetch_models.py --dest ./data/models    # offline: add --from /media/usb/models
cp ../services/engine/configs/cameras.yaml.example ../services/engine/configs/cameras.yaml
cp ../services/engine/configs/app_config.yaml.example ../services/engine/configs/app_config.yaml
docker compose up -d --build
```

Use the same folder for `--dest` as `ZOO_DATA_DIR` in `.env`, plus `/models`. Host data lives under
`ZOO_DATA_DIR` (default `./data`, git-ignored): `recordings/`, `snapshots/`, `models/`, `logs/`.

## Windows development

Run MediaMTX v1.21.1 locally. Download the Windows build from the MediaMTX GitHub releases into the
repo root (`mediamtx.exe` is git-ignored), then from the repo root run:

```powershell
.\mediamtx.exe deploy\mediamtx.yml
```

`mediamtx.yml` still holds the prototype's camera paths and FFmpeg test loops (Windows file paths).
Phase 4 replaces the static paths with cameras added through the web UI (MediaMTX Control API).
