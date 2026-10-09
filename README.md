# Zoo Vision (backend)

AI video analytics for Taman Safari: a Python vision engine watches about 12 park cameras (cashier desks, restaurant
occupancy and tables, the vehicle gate, horse rides), records them through MediaMTX and sends events, snapshots and clips
to the web dashboard. This repo is the backend; the web UI lives in
[zoo-vision-fe](https://github.com/Aryaputra34/zoo-vision-fe).

> **Where things are going:** the production architecture is in
> [the design spec](docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md). Phase 0
> (this layout) is done by [this plan](docs/superpowers/plans/2026-10-08-phase-0-restructure.md); the engine still reads
> its cameras and rules from YAML until the API arrives in Phase 1.

## Repo map

| Folder | What it holds |
| :--- | :--- |
| [`services/engine/`](services/engine/) | Python vision engine (uv project): pipelines, configs, tests, Dockerfile |
| [`integrations/nx/plugin/`](integrations/nx/plugin/) | Frozen C++ Nx Meta plugin, kept for a future Nx bridge |
| [`deploy/`](deploy/) | Docker Compose for one park server, MediaMTX config, `.env.example` |
| [`tools/`](tools/) | `fetch_models.py` (model weights), `export_model.py`, `pick_coordinates.py` |
| [`docs/`](docs/) | Guides, ADRs, the design spec and phase plans |
| [`.github/workflows/`](.github/workflows/) | CI: engine lint and tests, repo hygiene (no binaries in git) |

Later phases add `apps/api` (NestJS + Prisma) and `packages/contracts` (shared JSON Schemas).

## Quick start

| Task | Command | Details |
| :--- | :--- | :--- |
| Run the whole stack locally | MediaMTX + engine + dashboard | [docs/10_LOCAL_QUICKSTART.md](docs/10_LOCAL_QUICKSTART.md) |
| Engine dev setup | `cd services/engine && uv sync` | [services/engine/README.md](services/engine/README.md) |
| Model weights | `python tools/fetch_models.py` | [tools/README.md](tools/README.md) |
| Run a pipeline on a video | `cd services/engine && uv run python test_video.py --video sample_data/cars.mp4 --pipeline gate` | [docs/08](docs/08_TESTING_GUIDE.md) |
| Tests | `cd services/engine && uv run pytest` and `uvx --from "pytest>=8.3" pytest tools/tests` | |
| Deploy on a server | `cd deploy && docker compose up -d --build` | [deploy/README.md](deploy/README.md) |

Needs [uv](https://docs.astral.sh/uv/) and [git-lfs](https://git-lfs.com/) (the sample video is stored in LFS).

## Documentation

1. **[01_IMPLEMENTATION_PLAN.md](docs/01_IMPLEMENTATION_PLAN.md)**: original scope, use case matrix and delivery schedule (historical).
2. **[02_MODEL_BUILDING_GUIDE.md](docs/02_MODEL_BUILDING_GUIDE.md)**: PyTorch/Ultralytics training workflow, transfer learning per use case, plate OCR.
3. **[03_HARDWARE_SPECIFICATIONS.md](docs/03_HARDWARE_SPECIFICATIONS.md)**: compute and VRAM sizing, bill of materials.
4. **[04_ARCHITECTURE_DECISION_RECORDS.md](docs/04_ARCHITECTURE_DECISION_RECORDS.md)** and the **[ADR index](docs/adr/README.md)**.
5. **[05_MODEL_EXPORT_GUIDE.md](docs/05_MODEL_EXPORT_GUIDE.md)**: exporting `.pt` to ONNX, OpenVINO and TensorRT with `tools/export_model.py`.
6. **[06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md](docs/06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md)**: the C++ Nx plugin (historical; code in `integrations/nx/plugin/`).
7. **[07_INSTALLATION_GUIDE.md](docs/07_INSTALLATION_GUIDE.md)**: bare-metal and Docker installs, configuration, systemd, troubleshooting.
8. **[08_TESTING_GUIDE.md](docs/08_TESTING_GUIDE.md)**: testing every use case with recorded video and the web dashboard.
9. **[09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md](docs/09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md)**: MediaMTX recording, RTSP proxy and clip playback.
10. **[10_LOCAL_QUICKSTART.md](docs/10_LOCAL_QUICKSTART.md)**: run MediaMTX, the engine and the dashboard on a dev laptop.
11. **[architecture_best_practice_recommendation.md](docs/architecture_best_practice_recommendation.md)**: the prototype-era Nx vs. Python comparison (historical).
