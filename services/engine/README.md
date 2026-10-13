# Zoo Vision engine

Python vision engine: one worker per camera runs a YOLO + ByteTrack pipeline (cashier, restaurant,
tables, vehicle gate, horse riding) and sends events to the web dashboard.

Every command below runs from this folder (`services/engine/`). Paths in the configs, such as
`configs/rules/...` and `models/...`, are relative to it.

## Setup

1. Install [uv](https://docs.astral.sh/uv/) and [git-lfs](https://git-lfs.com/).
2. `uv sync` creates `.venv/` with Python 3.12 and the locked dependencies (`uv.lock`).

## Configs

Copy the example and edit it. The copy is git-ignored, because it holds camera URLs with passwords. The
engine itself takes its static settings from environment variables and its cameras from the API:

```bash
cp configs/cameras.yaml.example configs/cameras.yaml
```

Rules per use case live in `configs/rules/*.yaml`.

## Models

Weights are not in git. `models/manifest.json` lists them with checksums; fetch them with:

```bash
python ../../tools/fetch_models.py            # download into models/ (git-ignored)
python ../../tools/fetch_models.py --from DIR # offline: copy from a folder
```

A rule file's `model_name` is looked up as given first, then in `models/` (or in `$ZOO_MODELS_DIR`
if set). Ultralytics downloads its official `.pt` weights by name if they are missing. A missing
`.onnx` or `.engine` file stops the whole engine at startup with an error naming the file and the fetch
command (under Docker it then restarts until the weights are there); a missing plate detector only turns
ANPR off.

## Run

`sample_data/cars.mp4` is stored with Git LFS. Without git-lfs it is a small pointer file that
OpenCV cannot open: install git-lfs, then run `git lfs pull`.

The engine sends events, intervals and per-minute metrics to the Redis stream `events`. Environment:

| Variable | Meaning |
| :--- | :--- |
| `REDIS_URL` | e.g. `redis://localhost:6379/0`. If unset, nothing is sent and one warning says so. |
| `ENGINE_GROUP` | Name of this engine in `engine_started` messages (default `default`). |

```bash
uv run python main.py                                              # all enabled cameras
uv run python test_video.py --video <file.mp4> --pipeline <name>   # one pipeline on a video file
```

## Test and lint

```bash
uv run pytest          # set REDIS_URL to also run the Redis test
uv run ruff check .
```

## GPU

On Linux, torch comes from the PyTorch CUDA 12.6 wheel index (see `pyproject.toml`). It needs NVIDIA
driver 525.60 or newer (CUDA 12 minor-version compatibility); 560 or newer is recommended. Windows
development installs CPU torch from PyPI.
