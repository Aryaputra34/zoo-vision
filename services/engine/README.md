# Zoo Vision engine

Python vision engine: one worker per camera runs a YOLO + ByteTrack pipeline (cashier, restaurant,
tables, vehicle gate, horse riding) and sends events to the web dashboard.

Every command below runs from this folder (`services/engine/`). Relative paths, such as `models/...` and
`sample_data/...`, are relative to it.

## Setup

1. Install [uv](https://docs.astral.sh/uv/) and [git-lfs](https://git-lfs.com/).
2. `uv sync` creates `.venv/` with Python 3.12 and the locked dependencies (`uv.lock`).

## Configuration

The engine has no config file. Its static settings are environment variables (table below). Its cameras come
from the API: at start it fetches the enabled cameras of its `ENGINE_GROUP` from `GET /internal/engine/cameras`
(with `ENGINE_TOKEN`), and fetches again on every `cfg:changed` message, every Redis reconnect and every
60 s. A change saved in the web UI is applied between two frames, without reconnecting the stream. The engine
reports each camera in Redis as `cam:{id}:status` (every 5 s) and `cam:{id}:frame` (a JPEG every 2 s), which
the API serves; it also runs the model validation and ONNX conversion jobs from the `model:jobs` queue.

Add cameras through the API, not by editing files. To load a YAML camera list once, use
`tools/import_yaml_config.py` (see [the quickstart](../../docs/10_LOCAL_QUICKSTART.md)); the file it reads is
copied from the example and is git-ignored, because it holds camera URLs with passwords:

```bash
cp configs/cameras.yaml.example configs/cameras.yaml
```

`configs/cameras.yaml.example` and `configs/rules/*.yaml` stay for that import and for `test_video.py`.

## Models

Weights are not in git. `models/manifest.json` lists them with checksums; fetch them with:

```bash
python ../../tools/fetch_models.py            # download into models/ (git-ignored)
python ../../tools/fetch_models.py --from DIR # offline: copy from a folder
```

A camera's `model_name` (or a rule file's, in `test_video.py`) is looked up as given first, then in the models
folder (`ZOO_MODELS_DIR`, default `models/`). Under Docker and in production this is the same host folder the
API manages (`$ZOO_DATA_DIR/models`); see [deploy/README.md](../../deploy/README.md). Ultralytics downloads its official `.pt` weights by name if they are missing. A missing
`.onnx` or `.engine` file stops the whole engine at startup with an error naming the file and the fetch
command (under Docker it then restarts until the weights are there); a missing plate detector only turns
ANPR off.

## Run

`sample_data/cars.mp4` is stored with Git LFS. Without git-lfs it is a small pointer file that
OpenCV cannot open: install git-lfs, then run `git lfs pull`.

The engine sends events, intervals and per-minute metrics to the Redis stream `events`. An invalid
environment stops it at start and names every bad variable (never the value). Environment:

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `REDIS_URL` | required | `redis://[:password@]host:port/db` (or `rediss://`) |
| `ENGINE_TOKEN` | required | At least 32 characters; the same value as the API's. Sent as a Bearer token to `/internal/engine/*` |
| `API_URL` | `http://127.0.0.1:3001` | Where the engine fetches its cameras and reports model jobs |
| `ENGINE_GROUP` | `default` | The camera group this engine runs, `^[a-z0-9_-]{1,32}$` |
| `DEVICE` | `cpu` | Torch/ONNX device, e.g. `cuda:0` |
| `ZOO_MODELS_DIR` | `models` | The models folder (same folder the API manages) |
| `SNAPSHOT_DIR` | `snapshots` | Event JPEGs, served by the preview server |
| `SNAPSHOT_RETENTION_DAYS` | `30` | Older snapshots are deleted; `0` keeps them |
| `PREVIEW_HOST` / `PREVIEW_PORT` | `127.0.0.1` / `8000` | The preview and snapshot server the dashboard's live view uses |
| `PREVIEW_API_KEY` | empty | If set, every preview request needs `Authorization: Bearer <key>` |
| `ENGINE_MAX_BATCH` | `1` | Most frames batched into one model call, 1..16 |
| `ENGINE_MODEL_JOBS` | `on` | `on` or `off`: whether this engine runs validation and conversion jobs. A second engine group sets `off` |

```bash
uv run python main.py                                              # all enabled cameras of the group
uv run python test_video.py --video <file.mp4> --pipeline <name>   # one pipeline on a video file
```

`test_video.py` does not use the API: it still takes a rule YAML from `configs/rules/`.

## Use cases

Each use case is a folder `usecases/<name>/` with a `pipeline.py` holding one `BasePipeline` subclass whose
`use_case` is the contract's use case id. `usecases/__init__.py` finds them by scanning the folders, and
camera workers build pipelines through `create_pipeline`; two pipelines for one id fail at start.

To add a use case:

1. Add its contract first (events, intervals, settings, metrics; `packages/contracts/README.md`, "Add a use
   case"). `npm run generate` there writes the Python models into `contracts/<id>/`.
2. Create `usecases/<id>/pipeline.py` with the pipeline class.
3. Add tests under `tests/`.

## Test and lint

```bash
uv run pytest          # set REDIS_URL to also run the Redis test
uv run ruff check .
```

## GPU

On Linux, torch comes from the PyTorch CUDA 12.6 wheel index (see `pyproject.toml`). It needs NVIDIA
driver 525.60 or newer (CUDA 12 minor-version compatibility); 560 or newer is recommended. Windows
development installs CPU torch from PyPI.
