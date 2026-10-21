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
API manages (`$ZOO_DATA_DIR/models`); see [deploy/README.md](../../deploy/README.md). Ultralytics downloads its official `.pt` weights by name if they are missing. A camera
whose `.onnx` or `.engine` file is missing does not stop the engine: that config version is rejected (the
camera's `configError` names the file, and one `config_rejected` event is sent per version), the camera
keeps running its previous version or, if it has none, waits in `error`, and the engine loads the file
again at every resync (every 60 s, or on a config change), so the camera starts once the file is there. A
missing plate detector only turns ANPR off.

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
| `SNAPSHOT_DIR` | `snapshots` | Event JPEGs, served by the API |
| `SNAPSHOT_RETENTION_DAYS` | `0` | `0` keeps snapshots (the API's retention job owns them, kept events and audit cameras included); a number deletes older day folders |
| `ENGINE_MAX_BATCH` | `1` | Most frames batched into one model call, 1..16 |
| `ENGINE_MODEL_JOBS` | `on` | `on` or `off`: whether this engine runs validation and conversion jobs. A second engine group sets `off` |

Running from source, copy `.env.example` to `.env` (git-ignored and excluded from the Docker image) and fill
it in; the engine loads `services/engine/.env` at start. A variable already set in the real environment wins
over the file, so Docker and production are unaffected.

```bash
cp .env.example .env                                               # once, then edit the values
uv run python main.py                                              # all enabled cameras of the group
uv run python test_video.py --video <file.mp4> --pipeline <name>   # one pipeline on a video file
```

> **Windows with an NVIDIA GPU:** `pyproject.toml` defaults Windows to CPU wheels. To use your GPU, run
> `uv pip install --reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu124` and
> `uv pip install onnxruntime-gpu`, set `$env:UV_NO_SYNC = "1"` in PowerShell, and set `DEVICE=cuda:0` in `.env`.
> See [10_LOCAL_QUICKSTART.md](../../docs/10_LOCAL_QUICKSTART.md).

Stop the engine with Ctrl+C (also Ctrl+Break on Windows, SIGTERM under Docker); it stops every camera and closes their open intervals first.

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

## The `live` contract

What a pipeline puts in `cam:{id}:status` under `live` (the counters the Live page shows) is typed per use case:
`packages/contracts/usecases/<id>/live.schema.json`. Every field is optional and extra fields are allowed, so a
pipeline can add one without breaking the dashboard; to give the dashboard a new field, add it to the schema and
run `npm run generate` there.

`tests/test_live_contract.py` runs each pipeline on the detections its other tests use and validates the payload
of `get_dict()` against its schema, so a renamed or mistyped field fails here, not on the dashboard.

## Test and lint

```bash
uv run pytest          # set REDIS_URL to also run the Redis test
uv run ruff check .
```

## GPU

On Linux, torch comes from the PyTorch CUDA 12.6 wheel index (see `pyproject.toml`). It needs NVIDIA
driver 525.60 or newer (CUDA 12 minor-version compatibility); 560 or newer is recommended. Windows
development installs CPU torch from PyPI.
