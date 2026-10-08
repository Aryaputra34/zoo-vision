# Zoo Vision engine

Python vision engine: one worker per camera runs a YOLO + ByteTrack pipeline (cashier, restaurant,
tables, vehicle gate, horse riding) and sends events to the web dashboard.

Every command below runs from this folder (`services/engine/`). Paths in the configs, such as
`configs/rules/...` and `models/...`, are relative to it.

## Setup

1. Install [uv](https://docs.astral.sh/uv/) and [git-lfs](https://git-lfs.com/).
2. `uv sync` creates `.venv/` with Python 3.12 and the locked dependencies (`uv.lock`).

## Configs

Copy the examples and edit them. Both copies are git-ignored, because they hold camera URLs with
passwords and API keys:

```bash
cp configs/cameras.yaml.example configs/cameras.yaml
cp configs/app_config.yaml.example configs/app_config.yaml
```

Rules per use case live in `configs/rules/*.yaml`.

## Run

```bash
uv run python main.py                                              # all enabled cameras
uv run python test_video.py --video <file.mp4> --pipeline <name>   # one pipeline on a video file
```

## Test and lint

```bash
uv run pytest
uv run ruff check .
```

## GPU

On Linux, torch comes from the PyTorch CUDA 12.6 wheel index (see `pyproject.toml`). It needs NVIDIA
driver 525.60 or newer (CUDA 12 minor-version compatibility); 560 or newer is recommended. Windows
development installs CPU torch from PyPI.
