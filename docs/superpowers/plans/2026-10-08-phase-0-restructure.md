# Zoo Vision Phase 0 (Restructure) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into the backend repo layout from the spec (engine in `services/engine`,
Nx plugin in `integrations/nx/plugin`, `deploy/`, `tools/`), take binaries out of git, add CI, and
rename the frontend repo to `zoo-vision-fe`, without changing what the system does.

**Architecture:** A pure restructure. The engine keeps its YAML configs, HTTP event dispatch and
FastAPI server. It moves into a uv project under `services/engine/` and always runs from that
folder. Model weights leave git: a checksummed manifest plus `tools/fetch_models.py` download them
from a GitHub release, or copy them from a folder on offline sites, and the engine looks them up in
`models/`. Tests with a fake YOLO prove every pipeline still builds from its config and processes
frames. Running the same sample video before and after the move proves detection output is
unchanged.

**Tech Stack:** Python 3.12, uv 0.12.10, pytest, ruff, Ultralytics + supervision (versions unchanged
by intent), Docker (`nvidia/cuda` base), GitHub Actions, Git LFS. Frontend: Next.js 16, Node 22.

**Spec:** `docs/superpowers/specs/2026-10-08-zoo-vision-production-architecture-design.md`
(section 6: the repo layout, the "Out of git from phase 0 on" bullet, and phase 0 of "Path from the
prototype").

## Global Constraints

- Phase 0 changes no runtime behaviour: same pipelines, rule values, event payloads, engine HTTP
  API (`core/api_server.py`), dashboard ingest URL. Only paths, packaging, model file location and
  the missing-model error message change.
- Execute in the main checkout `C:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor`, not in a git
  worktree. Tasks use local untracked files: model weights, `configs/cameras.yaml`, the MediaMTX
  binary.
- Work on branch `phase-0-restructure`, created from `production-architecture` (which holds the
  spec and this plan). Never commit to `main`. Push, create GitHub releases and rename repos only
  after the user says yes.
- Git history is left as-is: no `git filter-repo`, no force-push.
- Removing a file someone may still use locally (binaries, weights, scratch) means
  `git rm --cached` plus an ignore rule. Never delete the local copy.
- Don't edit historical documents: `docs/adr/*`, `docs/01_IMPLEMENTATION_PLAN.md`,
  `docs/04_ARCHITECTURE_DECISION_RECORDS.md`, `docs/06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md`,
  `architecture_best_practice_recommendation.md` (moved, not edited), the spec.
- Engine: Python 3.12; uv 0.12.10, pinned in the Dockerfile and CI; `uv.lock` committed. Engine
  commands run from `services/engine/`; config paths such as `configs/rules/...` are relative to it.
- Linux installs torch and torchvision from `https://download.pytorch.org/whl/cu126`; other
  platforms use PyPI.
- Model release: GitHub release tag `models-v1` on `Aryaputra34/zoo-vision`. The repo is public, so
  release assets are public. Customer-specific models go through `fetch_models.py --from` (file
  share or USB), never the public release.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Needs the user

1. Task 3: create the GitHub release `models-v1` and upload five model files.
2. Task 10: rename `Aryaputra34/zoo-analytics-web` to `zoo-vision-fe` on GitHub.
3. Tasks 8, 10 and 11: approve each `git push`. Pull requests are opened from the compare links in
   Task 11.

## Not in Phase 0

- `apps/api` and `packages/contracts`, Redis, Postgres, use case registry, Caddy: Phase 1 and later.
- An Nx plugin CI job. It needs the Nx SDK in CI; the plugin README documents the local build.
- Publishing images from CI, plus install/backup scripts: Phase 5.
- EasyOCR weights for offline sites. They still download on the first ANPR start, as today.
- Proving GPU inference inside the Docker image: no GPU on the dev laptop or in CI. Covered by the
  Phase 5 soak test.

## Review Focus

1. **Operator config with camera passwords and API keys.** After the move,
   `services/engine/configs/cameras.yaml`, `app_config.yaml`, `.env` and `deploy/.env` must stay
   git-ignored and must never be copied into the Docker image. Tests in Task 1 and Task 7.
2. **Interrupted download, or the wrong file on a USB stick.** Expected: exit code 1, nothing at the
   final path, no `.part` file left behind. Tests in Task 3.
3. **Offline install from a folder.** `--from DIR` must work with no network at all, and must still
   check checksums. Tests in Task 3.
4. **A rule file names a model that the manifest lacks.** A fresh install would fail at camera
   start, so CI must catch it. Test in Task 4.
5. **An `.onnx` model is missing at runtime.** Expected: a clear error naming the file and
   `tools/fetch_models.py`. If the missing file is the plate detector, the gate camera keeps running
   without ANPR. Tests in Task 4.

## Target layout at the end of Phase 0

```
zoo-vision/
  .github/workflows/engine.yml, repo.yml
  services/engine/   main.py, test_video.py, simulate_demo.py, test_synthetic_demo.py,
                     core/, pipelines/, nx_integration/, configs/ (examples + rules), sample_data/ (LFS),
                     models/manifest.json, tests/, pyproject.toml, uv.lock, .python-version,
                     Dockerfile, .dockerignore, README.md
  integrations/nx/plugin/   (was magnet_nx_plugin/)
  deploy/            docker-compose.yml, mediamtx.yml, .env.example, README.md
  tools/             fetch_models.py, export_model.py, pick_coordinates.py, tests/, README.md
  docs/              existing guides + architecture_best_practice_recommendation.md + superpowers/
  README.md, LICENSE, .gitignore, .gitattributes
```

---

### Task 1: Engine moves to `services/engine` as a uv project

**Files:**
- Move (`git mv`): `main.py`, `test_video.py`, `simulate_demo.py`, `test_synthetic_demo.py`,
  `core/`, `pipelines/`, `nx_integration/`, `sample_data/`, `Dockerfile`,
  `configs/app_config.yaml.example`, `configs/cameras.yaml.example` and `configs/rules/`, all to
  the same names under `services/engine/`. `configs/mediamtx.yml` stays where it is until Task 7.
- Move (plain `mv`, untracked local files): `configs/app_config.yaml` and `configs/cameras.yaml` to
  `services/engine/configs/`
- Create: `services/engine/pyproject.toml`, `services/engine/uv.lock`, `services/engine/.python-version`,
  `services/engine/.dockerignore`, `services/engine/README.md`, `services/engine/tests/conftest.py`
- Modify: `.gitignore`, root `docker-compose.yml`, `services/engine/Dockerfile`
- Delete: `requirements.txt`
- Test: `services/engine/tests/test_imports.py`, `services/engine/tests/test_local_files_ignored.py`

**Interfaces:**
- Produces: engine root `services/engine/` (`uv sync`, `uv run python main.py`, `uv run pytest`,
  `uv run ruff check .`). `tests/conftest.py` defines `ENGINE_DIR: Path` (the engine root) and an
  autouse fixture `engine_cwd` that chdirs into `ENGINE_DIR`, so relative config paths work
  whatever directory pytest was started from.

- [ ] **Step 1: Start the branch**

Run: `git status --short`. Expected: no output. If anything is listed, stop and ask the user to
commit or stash it. Then run `git switch -c phase-0-restructure production-architecture`.

- [ ] **Step 2: Create the uv project**

`services/engine/.python-version` contains `3.12`. `services/engine/pyproject.toml`:

```toml
[project]
name = "zoo-vision-engine"
version = "0.1.0"
description = "Zoo Vision AI engine: per-camera YOLO + ByteTrack pipelines"
requires-python = ">=3.12,<3.13"
dependencies = [
    # from the prototype's requirements.txt
    "ultralytics>=8.3.0",
    "supervision>=0.23.0",
    "shapely>=2.0.3",
    "easyocr>=1.7.0",
    "requests>=2.31.0",
    "urllib3>=2.2.1",
    "fastapi>=0.111.0",
    "uvicorn>=0.30.0",
    "pydantic>=2.7.0",
    "pyyaml>=6.0.1",
    "python-dotenv>=1.0.1",
    "tqdm>=4.66.2",
    # declared so Ultralytics never pip-installs them at runtime (fails on offline sites)
    "torch>=2.4",
    "torchvision>=0.19",
    "onnx>=1.16",
    "onnxruntime>=1.18; sys_platform != 'linux'",
    "onnxruntime-gpu>=1.18; sys_platform == 'linux'",
]

[dependency-groups]
dev = ["pytest>=8.3", "ruff>=0.16"]

[tool.uv]
package = false
# easyocr pulls the headless OpenCV build, which would shadow cv2's GUI used by test_video.py
override-dependencies = ["opencv-python-headless; sys_platform == 'never'"]

[tool.uv.sources]
torch = [{ index = "pytorch-cu126", marker = "sys_platform == 'linux'" }]
torchvision = [{ index = "pytorch-cu126", marker = "sys_platform == 'linux'" }]

[[tool.uv.index]]
name = "pytorch-cu126"
url = "https://download.pytorch.org/whl/cu126"
explicit = true

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
target-version = "py312"
line-length = 120

[tool.ruff.lint]
# Phase 0: syntax errors and undefined names only (the prototype passes this today)
select = ["E9", "F63", "F7", "F82"]
```

Run: `cd services/engine && uv lock && uv sync`.
Expected: both succeed. `uv run python -c "import torch; print(torch.__version__)"` prints a 2.x
version.

- [ ] **Step 3: Write the failing tests**

`services/engine/tests/conftest.py`:
```python
from pathlib import Path
import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]

@pytest.fixture(autouse=True)
def engine_cwd(monkeypatch):
    monkeypatch.chdir(ENGINE_DIR)
```

`services/engine/tests/test_imports.py`:
```python
import importlib
from importlib import metadata
import pytest
from conftest import ENGINE_DIR

SCRIPTS = ["main", "test_video", "simulate_demo", "test_synthetic_demo"]
PACKAGES = ["core", "pipelines", "nx_integration"]
MODULES = SCRIPTS + sorted(f"{d}.{p.stem}" for d in PACKAGES for p in (ENGINE_DIR / d).glob("*.py"))

@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module):
    importlib.import_module(module)

def test_onnx_runtime_is_a_declared_dependency():
    import onnx, onnxruntime  # noqa: F401

def test_headless_opencv_is_not_installed():
    with pytest.raises(metadata.PackageNotFoundError):
        metadata.version("opencv-python-headless")
```

`services/engine/tests/test_local_files_ignored.py`:
```python
import subprocess
import pytest
from conftest import ENGINE_DIR

@pytest.mark.parametrize("path", ["configs/cameras.yaml", "configs/app_config.yaml", ".env"])
def test_local_operator_files_are_git_ignored(path):
    assert subprocess.run(["git", "check-ignore", "-q", path], cwd=ENGINE_DIR).returncode == 0

def test_dockerignore_keeps_local_files_out_of_image():
    lines = {line.strip() for line in (ENGINE_DIR / ".dockerignore").read_text().splitlines()}
    assert {"configs/cameras.yaml", "configs/app_config.yaml", ".env", "models/", ".venv/"} <= lines
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd services/engine && uv run pytest -q`
Expected: FAIL. There's `ModuleNotFoundError: No module named 'main'` and similar, `check-ignore`
returns 1 for the configs, and `.dockerignore` is missing.

- [ ] **Step 5: Move the engine**

1. In `.gitignore`, replace `configs/app_config.yaml` and `configs/cameras.yaml` with
   `services/engine/configs/app_config.yaml` and `services/engine/configs/cameras.yaml`.
2. Run `mkdir -p services/engine/configs`, then the `git mv` commands from the Files list.
3. Run `mv configs/app_config.yaml configs/cameras.yaml services/engine/configs/`.

- [ ] **Step 6: Dockerfile, .dockerignore, compose, requirements**

`services/engine/Dockerfile` (same base and apt packages as before; uv replaces pip):
```dockerfile
# CUDA runtime base; torch brings its own CUDA 12.6 libraries (pyproject.toml: pytorch-cu126 index)
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /uvx /bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_PROJECT_ENVIRONMENT=/opt/venv UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY . .
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
```

`services/engine/.dockerignore`, one pattern per line: `.venv/`, `**/__pycache__/`,
`.pytest_cache/`, `.ruff_cache/`, `tests/`, `models/`, `sample_data/`, `snapshots/`,
`recordings/`, `logs/`, `*.mp4`, `*.pt`, `*.onnx`, `*.engine`, `configs/cameras.yaml`,
`configs/app_config.yaml`, `.env`.

In the root `docker-compose.yml`:
- `build: .` becomes `build: ./services/engine`.
- `./configs:/app/configs` becomes `./services/engine/configs:/app/configs`.
- `./models:/app/models` becomes `./services/engine/models:/app/models`.

Task 7 moves this file. Then run `git rm requirements.txt`.

- [ ] **Step 7: Run the tests and lint to verify they pass**

Run: `cd services/engine && uv run pytest -q && uv run ruff check .`
Expected: all tests pass and ruff prints `All checks passed!`. In `git status --short`, neither
`cameras.yaml` nor `app_config.yaml` appears.

- [ ] **Step 8: Write `services/engine/README.md`**

Sections:
- Setup: install uv and git-lfs, then `uv sync`.
- Configs: copy `configs/*.example` to `configs/cameras.yaml` and `configs/app_config.yaml`; both
  are git-ignored.
- Run: `uv run python main.py`, and
  `uv run python test_video.py --video <file> --pipeline <name>`.
- Test and lint: `uv run pytest`, `uv run ruff check .`.
- Every command runs from this folder.
- GPU: on Linux, torch comes from the CUDA 12.6 wheel index. That needs NVIDIA driver 525.60 or
  newer (CUDA 12 minor-version compatibility); 560 or newer is recommended. Windows dev installs
  CPU torch from PyPI.

- [ ] **Step 9: Commit**

```bash
git add -A services/engine .gitignore docker-compose.yml
git add -u
git status --short   # only renames, the new engine files, the deleted requirements.txt
git commit -m "refactor: move engine to services/engine as a uv project"
```

---

### Task 2: Pipeline factory and wiring tests with a fake YOLO

**Files:**
- Modify: `services/engine/main.py` (move the `if/elif` pipeline chain out of `main()` into `create_pipeline`)
- Modify: `services/engine/tests/conftest.py` (add `FakeYOLO`, `FakeReader`, fixture `fake_yolo`)
- Test: `services/engine/tests/test_pipeline_wiring.py`

**Interfaces:**
- Consumes: `ENGINE_DIR` and `engine_cwd` from Task 1.
- Produces:
  - `main.create_pipeline(cam: dict, nx_client: NxClient, device: str) -> Optional[BasePipeline]`.
    It reads the same camera keys `main()` reads today: `id`, `name` (defaults to the id),
    `pipeline`, `rule_config` (default `""`), `nx_camera_id` (default
    `"00000000-0000-0000-0000-000000000000"`), `roi`, `rules`. It returns `None` and logs the
    existing warning for an unknown type.
  - `main()` keeps assigning `analytics`, `snapshots` and `recording_path` and building the stream.
  - Fixture `fake_yolo` patches `core.base_pipeline.YOLO` and `core.anpr_engine.YOLO` with
    `FakeYOLO`, and `core.anpr_engine.easyocr.Reader` with `FakeReader`.
  - `RULES: dict[str, str]` in `test_pipeline_wiring.py` maps each pipeline to its rule file.
    Task 4 reuses it.

- [ ] **Step 1: Add the fakes to `conftest.py`**

```python
import torch, yaml, ultralytics
from ultralytics.engine.results import Results

COCO_NAMES = yaml.safe_load(
    (Path(ultralytics.__file__).parent / "cfg/datasets/coco.yaml").read_text(encoding="utf-8"))["names"]

class FakeYOLO:
    """Stands in for ultralytics.YOLO: loads no weights, detects nothing."""
    def __init__(self, model=None, task=None):
        self.model_name, self.names = model, dict(COCO_NAMES)
    def __call__(self, source, **kwargs):
        return [Results(orig_img=source, path="", names=self.names, boxes=torch.zeros((0, 6)))]

class FakeReader:
    def __init__(self, *args, **kwargs): pass
    def readtext(self, *args, **kwargs): return []

@pytest.fixture
def fake_yolo(monkeypatch):
    monkeypatch.setattr("core.base_pipeline.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.easyocr.Reader", FakeReader)
    return FakeYOLO
```

- [ ] **Step 2: Write the failing tests**

`services/engine/tests/test_pipeline_wiring.py`:
```python
import numpy as np
import pytest
import yaml
from conftest import ENGINE_DIR
from main import create_pipeline
from nx_integration.nx_client import NxClient
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.horse_riding_pipeline import HorseRidingPipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline
from pipelines.table_occupancy_pipeline import TableOccupancyPipeline
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline

RULES = {
    "cashier_presence": "configs/rules/cashier_presence.yaml",
    "restaurant_counter": "configs/rules/restaurant_counter.yaml",
    "restaurant_table": "configs/rules/restaurant_table.yaml",
    "vehicle_gate": "configs/rules/vehicle_gate.yaml",
    "horse_riding": "configs/rules/horse_riding.yaml",
}
# every pipeline name main.py accepts today -> (class, rule file key)
TYPES = {
    "cashier_presence": (CashierPresencePipeline, "cashier_presence"),
    "restaurant_counter": (RestaurantCounterPipeline, "restaurant_counter"),
    "restaurant": (RestaurantCounterPipeline, "restaurant_counter"),
    "restaurant_table": (TableOccupancyPipeline, "restaurant_table"),
    "table_occupancy": (TableOccupancyPipeline, "restaurant_table"),
    "table_monitor": (TableOccupancyPipeline, "restaurant_table"),
    "vehicle_gate": (VehicleGatePipeline, "vehicle_gate"),
    "horse_riding": (HorseRidingPipeline, "horse_riding"),
    "horse_tracking": (HorseRidingPipeline, "horse_riding"),
    "horse": (HorseRidingPipeline, "horse_riding"),
}

def camera(pipeline_type, rule_key, **extra):
    return {"id": "cam_test", "name": "Test Cam", "pipeline": pipeline_type, "rule_config": RULES[rule_key], **extra}

@pytest.mark.parametrize("pipeline_type", TYPES)
def test_create_pipeline_picks_the_class(fake_yolo, pipeline_type):
    cls, rule_key = TYPES[pipeline_type]
    assert type(create_pipeline(camera(pipeline_type, rule_key), NxClient(mock_mode=True), "cpu")) is cls

def test_unknown_pipeline_type_returns_none(fake_yolo):
    assert create_pipeline({"id": "x", "pipeline": "nope"}, NxClient(mock_mode=True), "cpu") is None

@pytest.mark.parametrize("rule_key", RULES)
def test_pipeline_processes_frames(fake_yolo, rule_key):
    pipeline = create_pipeline(camera(rule_key, rule_key), NxClient(mock_mode=True), "cpu")
    frame = np.zeros((720, 1280, 3), np.uint8)
    for ts in (0, 200):
        out = pipeline.run(frame.copy(), ts)
        assert out.shape == frame.shape and out.dtype == np.uint8
    assert pipeline.latest_frame() is not None

def test_every_enabled_example_camera_builds(fake_yolo):
    cams = yaml.safe_load((ENGINE_DIR / "configs/cameras.yaml.example").read_text(encoding="utf-8"))["cameras"]
    for cam in cams:
        if cam.get("enabled", True):
            assert create_pipeline(cam, NxClient(mock_mode=True), "cpu") is not None, cam["id"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd services/engine && uv run pytest tests/test_pipeline_wiring.py -q`
Expected: FAIL with `ImportError: cannot import name 'create_pipeline' from 'main'`.

- [ ] **Step 4: Implement `create_pipeline` in `services/engine/main.py`**

Move the existing `if/elif` chain into the function unchanged: same classes, aliases, constructor
arguments and warning text. `main()` then calls it and does `continue` when it returns `None`.

- [ ] **Step 5: Run all engine tests to verify they pass**

Run: `cd services/engine && uv run pytest -q && uv run ruff check .`. Expected: PASS.
If a pipeline indexes `self.model.names` or result fields in a way the fake doesn't cover, extend
`FakeYOLO` to match how the real Ultralytics object behaves. Don't change the pipeline.

- [ ] **Step 6: Commit**

```bash
git add services/engine/main.py services/engine/tests
git commit -m "test: pipeline wiring tests with a fake YOLO; extract create_pipeline"
```

---

### Task 3: `tools/fetch_models.py` and the model manifest

**Files:**
- Create: `tools/fetch_models.py`, `tools/tests/conftest.py`, `tools/tests/test_fetch_models.py`,
  `services/engine/models/manifest.json`, `tools/README.md`

**Interfaces:**
- Produces (standard library only, so it runs with a server's system `python3`):
  - `@dataclass(frozen=True) class ModelEntry: file: str; sha256: str; size: int; url: str`
  - `class FetchError(Exception)`
  - `load_manifest(path: Path) -> list[ModelEntry]`
  - `sha256_of(path: Path) -> str`
  - `fetch(entry: ModelEntry, dest: Path, source_dir: Path | None = None) -> str` returns
    `"present"` or `"fetched"`, and raises `FetchError`.
  - `main(argv: list[str] | None = None) -> int`
  - CLI: `python tools/fetch_models.py [--manifest PATH] [--dest DIR] [--from DIR] [--only FILE]...`
    - Default manifest: `<repo>/services/engine/models/manifest.json`, resolved from `__file__`.
    - Default dest: the manifest's folder. `--from` is stored as `source_dir`.
    - Prints one line per model: `ok      <file> (present|fetched)` or `FAILED  <file>: <reason>`.
    - Exit codes: 0 when every selected model is ok, 1 when any fails, 2 when `--only` names a file
      that isn't in the manifest.
- Manifest format:
  - `{"release": "models-v1", "models": [{"file", "sha256", "size", "url"}]}`
  - `url` is `https://github.com/Aryaputra34/zoo-vision/releases/download/models-v1/<file>`.
- `fetch` rules:
  1. If `dest/file` exists and its sha256 matches, return `"present"` without any network access.
  2. Source:
     - With `source_dir`: copy `source_dir/file`. If it's missing, raise `FetchError("... not found
       in <dir>")`; never fall back to the URL.
     - Otherwise: `urllib.request.urlopen(entry.url, timeout=60)`.
  3. Stream into `dest/.<file>.part`, hashing as it goes.
     - If the sha256 doesn't match, delete the `.part` file and raise `FetchError("checksum
       mismatch ...")`.
     - On success, `os.replace` it to `dest/file` and return `"fetched"`.
     - If anything raises, remove the `.part` file.
  4. Create `dest` if it is missing.

- [ ] **Step 1: Write the failing tests**

`tools/tests/conftest.py` puts `tools/` on `sys.path`
(`sys.path.insert(0, str(Path(__file__).resolve().parents[1]))`).

`tools/tests/test_fetch_models.py` (`entry(...)` is a local helper that builds a `ModelEntry` with
the real sha256 and size of `data` unless overridden):
```python
import hashlib, json, re
from pathlib import Path
import pytest
import fetch_models as fm

DATA = b"weights-v1"
UNREACHABLE = "http://127.0.0.1:9/unreachable"

def entry(src: Path, **over):
    fields = dict(file=src.name, sha256=hashlib.sha256(DATA).hexdigest(), size=len(DATA), url=src.as_uri())
    return fm.ModelEntry(**{**fields, **over})

@pytest.fixture
def src(tmp_path):
    (tmp_path / "src").mkdir(); p = tmp_path / "src" / "m.onnx"; p.write_bytes(DATA); return p

def test_fetch_downloads_and_verifies(src, tmp_path):
    dest = tmp_path / "dest"
    assert fm.fetch(entry(src), dest) == "fetched"
    assert (dest / "m.onnx").read_bytes() == DATA and list(dest.glob(".*.part")) == []

def test_present_file_is_not_fetched_again(src, tmp_path):
    fm.fetch(entry(src), tmp_path / "dest")
    assert fm.fetch(entry(src, url=UNREACHABLE), tmp_path / "dest") == "present"

def test_corrupt_existing_file_is_replaced(src, tmp_path):
    dest = tmp_path / "dest"; dest.mkdir(); (dest / "m.onnx").write_bytes(b"broken")
    assert fm.fetch(entry(src), dest) == "fetched" and (dest / "m.onnx").read_bytes() == DATA

def test_checksum_mismatch_leaves_nothing_behind(src, tmp_path):
    dest = tmp_path / "dest"
    with pytest.raises(fm.FetchError, match="checksum"):
        fm.fetch(entry(src, sha256="0" * 64), dest)
    assert not (dest / "m.onnx").exists() and list(dest.glob(".*.part")) == []

def test_from_dir_copies_without_network(src, tmp_path):
    assert fm.fetch(entry(src, url=UNREACHABLE), tmp_path / "dest", source_dir=src.parent) == "fetched"

def test_from_dir_missing_file_fails(src, tmp_path):
    with pytest.raises(fm.FetchError, match="not found"):
        fm.fetch(entry(src, file="other.onnx"), tmp_path / "dest", source_dir=src.parent)

def test_main_exit_codes(src, tmp_path, capsys):
    good, bad = entry(src), entry(src, file="bad.onnx", sha256="0" * 64)  # bad downloads m.onnx, wrong hash
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"release": "t", "models": [good.__dict__, bad.__dict__]}))
    assert fm.main(["--manifest", str(manifest), "--dest", str(tmp_path / "d")]) == 1
    out = capsys.readouterr().out
    assert "ok" in out and "FAILED  bad.onnx" in out
    assert fm.main(["--manifest", str(manifest), "--only", "nope.onnx"]) == 2

def test_repo_manifest_is_well_formed():
    manifest = Path(fm.__file__).resolve().parents[1] / "services/engine/models/manifest.json"
    entries = fm.load_manifest(manifest)
    assert entries and len({e.file for e in entries}) == len(entries)
    for e in entries:
        assert re.fullmatch(r"[0-9a-f]{64}", e.sha256) and e.size > 0
        assert e.url == f"https://github.com/Aryaputra34/zoo-vision/releases/download/models-v1/{e.file}"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uvx --from "pytest>=8.3" pytest -q tools/tests` (from the repo root)
Expected: FAIL with `ModuleNotFoundError: No module named 'fetch_models'`.

- [ ] **Step 3: Implement `tools/fetch_models.py`**

Follow the interfaces and rules above. Hash in 1 MiB chunks.

- [ ] **Step 4: Write the manifest from the local weights**

These five models are what the rule files reference today. Run `sha256sum` and `stat -c %s` on
`yolo11s.pt`, `yolo11s.onnx`, `yolo26s.onnx`, `yolo26l.onnx` and `models/license_plate_detector.onnx`
(paths relative to the repo root). Write one entry per file to
`services/engine/models/manifest.json`, with `"release": "models-v1"` and the URL format above.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uvx --from "pytest>=8.3" pytest -q tools/tests`. Expected: PASS.

- [ ] **Step 6: Ask the user to publish the release**

Ask the user to do the following on GitHub:
1. Open Aryaputra34/zoo-vision → Releases → "Draft a new release".
2. Tag `models-v1` (create it on `main`), title "Model weights v1".
3. Attach the five files from Step 4 and publish.

Tell them the assets will be public. Continue with Task 4 while they do it; the download is checked
in Task 11.

- [ ] **Step 7: Write `tools/README.md` (fetch section)**

- Online install: `python3 tools/fetch_models.py`.
- Server install: `--dest <data>/models`.
- Offline install: `--from /media/usb/models`.
- Adding a model:
  1. Upload it to the release (or a new `models-vN` release).
  2. Add its entry with `sha256sum` and size.
  3. Reference it from a rule file.
- Customer-specific models: `--from` only.

- [ ] **Step 8: Commit**

```bash
git add tools services/engine/models/manifest.json
git commit -m "feat: fetch_models tool with checksummed model manifest"
```

---

### Task 4: The engine finds models in `models/`; the self-healing download goes

**Files:**
- Create: `services/engine/core/model_store.py`
- Modify:
  - `services/engine/core/base_pipeline.py:74`
  - `services/engine/core/anpr_engine.py:66-72`
  - `export_model.py`: delete `setup_license_plate_model`, the `--setup-plate-model` and `--force`
    flags and their dispatch
  - `services/engine/tests/conftest.py` (the `fake_yolo` fixture)
  - `services/engine/README.md` (Models section)
- Delete: `services/engine/core/model_downloader.py`
- Test: `services/engine/tests/test_model_store.py`, `services/engine/tests/test_config_models.py`,
  `services/engine/tests/test_pipeline_wiring.py` (one test added)

**Interfaces:**
- Consumes: `services/engine/models/manifest.json` (the `models[].file` names) from Task 3;
  `fake_yolo`, `create_pipeline` and `RULES` from Task 2.
- Produces: `core.model_store.resolve_model_path(name: str, models_dir: str | None = None) -> str`,
  plus `MODELS_DIR_ENV = "ZOO_MODELS_DIR"`. The models folder is `models_dir`, else
  `$ZOO_MODELS_DIR`, else `"models"` (relative to the engine root). Resolution order:
  1. If `name` exists as given, return `name` unchanged.
  2. Else if `<models_dir>/<basename(name)>` exists, return `os.path.join(models_dir, basename(name))`.
  3. Else if `name` ends in `.pt`, return `name` unchanged; Ultralytics downloads official weights
     by name, as today.
  4. Else raise `FileNotFoundError(f"Model '{name}' not found (looked in '{models_dir}'). Run: python tools/fetch_models.py")`.

- [ ] **Step 1: Write the failing tests**

`services/engine/tests/test_model_store.py` (each test chdirs into `tmp_path` with
`monkeypatch.chdir`):
- `test_existing_path_is_returned_unchanged`: `x.onnx` exists in the cwd, so the result is `"x.onnx"`.
- `test_bare_name_found_in_models_dir`: `models/yolo26s.onnx` exists, so
  `resolve_model_path("yolo26s.onnx")` returns `os.path.join("models", "yolo26s.onnx")`.
- `test_models_dir_from_env`: `ZOO_MODELS_DIR=<tmp>/data` and the file is there, so the result is
  that joined path.
- `test_prefixed_path_falls_back_to_models_dir`: `"models/license_plate_detector.onnx"` is absent
  as given but present in the `$ZOO_MODELS_DIR` folder, so the result is the env-folder path.
- `test_missing_pt_passes_through`: `resolve_model_path("yolo11s.pt") == "yolo11s.pt"`.
- `test_missing_onnx_raises_with_fetch_hint`:
  `pytest.raises(FileNotFoundError, match="tools/fetch_models.py")`.

`services/engine/tests/test_config_models.py`:
```python
import json, os
import yaml
from conftest import ENGINE_DIR

def test_every_model_named_in_configs_is_in_the_manifest():
    manifest = {m["file"] for m in json.loads((ENGINE_DIR / "models/manifest.json").read_text())["models"]}
    named = set()
    for rule_file in (ENGINE_DIR / "configs/rules").glob("*.yaml"):
        rules = yaml.safe_load(rule_file.read_text(encoding="utf-8")) or {}
        if "model_name" in rules:
            named.add(rules["model_name"])
        if "model_path" in rules.get("anpr", {}):
            named.add(os.path.basename(rules["anpr"]["model_path"]))
    for cam in yaml.safe_load((ENGINE_DIR / "configs/cameras.yaml.example").read_text(encoding="utf-8"))["cameras"]:
        if "model_name" in (cam.get("rules") or {}):
            named.add(cam["rules"]["model_name"])
    assert named - manifest == set()
```

Add to `services/engine/tests/test_pipeline_wiring.py`:
```python
def test_gate_without_plate_model_runs_without_anpr(fake_yolo, monkeypatch, tmp_path):
    monkeypatch.setenv("ZOO_MODELS_DIR", str(tmp_path))  # empty folder: the plate model is missing
    cam = camera("vehicle_gate", "vehicle_gate",
                 rules={"anpr": {"enabled": True, "model_path": "missing/license_plate_detector.onnx"}})
    pipeline = create_pipeline(cam, NxClient(mock_mode=True), "cpu")
    assert pipeline.anpr_enabled is False
    frame = np.zeros((720, 1280, 3), np.uint8)
    assert pipeline.run(frame, 0).shape == frame.shape
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd services/engine && uv run pytest -q`
Expected: `test_model_store` fails with `ModuleNotFoundError: core.model_store`. The gate test
fails: the old self-heal tries to download, or `anpr_enabled` stays truthy.

- [ ] **Step 3: Implement**

1. Create `core/model_store.py` as specified in Interfaces.
2. `base_pipeline.py:74` becomes `self.model = YOLO(resolve_model_path(model_name), task="detect")`.
   Import it in both modules as `from core.model_store import resolve_model_path`; the fixture patches
   that module-level name.
3. In `anpr_engine.py`, replace the self-heal block (lines 66-72) with
   `detector_model_path = resolve_model_path(detector_model_path)`. `VehicleGatePipeline` already
   catches the exception and disables ANPR.
4. `git rm services/engine/core/model_downloader.py`.
5. Remove the plate-model setup from `export_model.py`, and its import of `core.model_downloader`.
6. In the `fake_yolo` fixture, add
   `monkeypatch.setattr("core.base_pipeline.resolve_model_path", lambda name, models_dir=None: name)`.
   Only the base pipeline's lookup is faked, so the gate test above uses the real lookup for ANPR.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd services/engine && uv run pytest -q && uv run ruff check .`. Expected: PASS.

- [ ] **Step 5: Put the local weights where the engine looks, then smoke-run**

From the repo root:
```bash
python tools/fetch_models.py --from . --only yolo11s.pt --only yolo11s.onnx --only yolo26s.onnx --only yolo26l.onnx
python tools/fetch_models.py --from models --only license_plate_detector.onnx
cd services/engine && uv run python test_video.py --video sample_data/cars.mp4 --pipeline gate --no-gui --no-anpr --duration 5
```
Expected:
- Each fetch line prints `ok ... (fetched)`.
- The run logs `Loading vision model 'models/yolo26l.onnx'` and ends with
  `Test video playback ended.`

- [ ] **Step 6: Add a Models section to `services/engine/README.md`**

- Weights live in `models/` (git-ignored; the manifest is tracked) and come from
  `python ../../tools/fetch_models.py`.
- `ZOO_MODELS_DIR` overrides the folder.
- `.pt` names Ultralytics knows are downloaded on demand.

- [ ] **Step 7: Commit**

```bash
git add -A services/engine export_model.py
git commit -m "feat: engine resolves models from models/; drop self-healing downloader"
```

---

### Task 5: Binaries and scratch out of git; tools and Git LFS

**Files:**
- Untrack with `git rm --cached` (local copies stay): `mediamtx.exe`, `mediamtx.yml`, `mediamtx/`
  (4 files), `yolo11s.onnx`, `yolo11s_openvino_model/` (3 files), `models/license_plate_detector.onnx`,
  `scratch/` (38 files)
- Delete: `kernel.errors.txt`
- Move:
  - `export_model.py` → `tools/export_model.py`
  - `pick_coordinates.py` → `tools/pick_coordinates.py`, with its rules folder as a constant
- Git LFS: `services/engine/sample_data/cars.mp4`
- Modify: `.gitattributes`, `.gitignore` (full rewrite), `tools/README.md`, `services/engine/README.md`
- Test: `tools/tests/test_repo_hygiene.py`

**Interfaces:**
- Produces:
  - `tools/export_model.py` and `tools/pick_coordinates.py` run from the repo root with the engine
    environment: `uv run --project services/engine python tools/<script>.py`.
  - `pick_coordinates.RULES_DIR = Path(__file__).resolve().parent.parent / "services" / "engine" / "configs" / "rules"`.

- [ ] **Step 1: Write the failing tests**

`tools/tests/test_repo_hygiene.py`:
```python
import subprocess
from pathlib import Path
import pytest

REPO = Path(__file__).resolve().parents[2]
BINARY_SUFFIXES = (".onnx", ".pt", ".engine", ".bin", ".exe", ".tar.gz", ".zip", ".mp4", ".jpg")
MAX_BLOB_BYTES = 2_000_000

def tracked_blobs() -> dict[str, int]:
    """Path -> size of the blob stored in git (an LFS file counts as its small pointer)."""
    out = subprocess.run(["git", "ls-files", "-s", "-z"], cwd=REPO, capture_output=True, check=True).stdout.decode()
    entries = [e.split("\t", 1) for e in out.split("\0") if e]
    shas = "\n".join(meta.split()[1] for meta, _ in entries) + "\n"
    sizes = subprocess.run(["git", "cat-file", "--batch-check=%(objectsize)"], cwd=REPO, input=shas,
                           capture_output=True, text=True, check=True).stdout.split()
    return {path: int(size) for (_, path), size in zip(entries, sizes)}

def test_binaries_are_only_lfs_pointers():
    assert {p: s for p, s in tracked_blobs().items() if p.lower().endswith(BINARY_SUFFIXES) and s > 1024} == {}

def test_no_large_blobs():
    assert {p: s for p, s in tracked_blobs().items() if s > MAX_BLOB_BYTES} == {}

@pytest.mark.parametrize("path", ["mediamtx.exe", "mediamtx/mediamtx.exe", "mediamtx.yml", "yolo11s.onnx",
                                  "services/engine/models/yolo26s.onnx", "scratch/notes.py"])
def test_local_files_are_ignored(path):
    assert subprocess.run(["git", "check-ignore", "-q", path], cwd=REPO).returncode == 0

def test_model_manifest_is_not_ignored():
    assert subprocess.run(["git", "check-ignore", "-q", "services/engine/models/manifest.json"], cwd=REPO).returncode == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uvx --from "pytest>=8.3" pytest -q tools/tests/test_repo_hygiene.py`
Expected: FAIL. The offenders listed include `mediamtx/mediamtx.exe`, `yolo11s.onnx` and the
`scratch/*.jpg` files.

- [ ] **Step 3: Untrack, delete and move**

Run the `git rm --cached -r` and `git rm` commands from the Files list, then `git mv` the two tools.

In `tools/pick_coordinates.py`:
- Add `RULES_DIR`.
- Replace the `"configs/rules/restaurant_counter.yaml"` and `"configs/rules/restaurant_table.yaml"`
  literals at lines 49-52 and 198-199 with `str(RULES_DIR / "<name>.yaml")`.
- In the printed hints at lines 148, 165 and 171, change `configs/` to `services/engine/configs/`.

- [ ] **Step 4: Rewrite `.gitignore`**

```gitignore
# Python
__pycache__/
.venv/
.pytest_cache/
.ruff_cache/
.env

# Local operator config (camera URLs with passwords, API keys); only *.example files are tracked
services/engine/configs/app_config.yaml
services/engine/configs/cameras.yaml

# Model weights: fetched by tools/fetch_models.py; only the manifest is tracked
*.pt
*.onnx
*.engine
*.xml
*.bin
yolo11s_openvino_model/
services/engine/models/*
!services/engine/models/manifest.json

# Videos and images (small test videos go through Git LFS, see .gitattributes)
*.mp4
*.jpg

# Runtime output
snapshots/
recordings/
logs/
deploy/data/

# Local binaries and SDKs (deployment uses the bluenviron/mediamtx image)
/mediamtx.exe
/mediamtx.yml
/mediamtx/
metavms-server_plugin_sdk-*/

# Personal experiments
scratch/
```

- [ ] **Step 5: Move the sample video to Git LFS**

```bash
git lfs install --local
echo 'services/engine/sample_data/*.mp4 filter=lfs diff=lfs merge=lfs -text' >> .gitattributes
git rm --cached services/engine/sample_data/cars.mp4
git add .gitattributes && git add -f services/engine/sample_data/cars.mp4
git lfs ls-files   # expect: services/engine/sample_data/cars.mp4
```

- [ ] **Step 6: Run all tests to verify they pass**

Run:
```bash
uvx --from "pytest>=8.3" pytest -q tools/tests
cd services/engine && uv run pytest -q
uv run --project services/engine python tools/pick_coordinates.py --help
uv run --project services/engine python tools/export_model.py --list
```
The last two run from the repo root. Expected: PASS, and both tools exit 0.

- [ ] **Step 7: Update the READMEs**

- `tools/README.md`: add `export_model.py` (export `.pt` to ONNX/OpenVINO/TensorRT) and
  `pick_coordinates.py` (draw lines, polygons and tables on a frame; edits the rule files), both
  run with `uv run --project services/engine`.
- `services/engine/README.md`: `sample_data/` needs git-lfs; without it `cars.mp4` is a small
  pointer file that OpenCV can't open.

- [ ] **Step 8: Commit**

```bash
git add -A tools .gitignore .gitattributes services/engine/README.md
git add -u
git status --short   # no weights, exe, tarball, jpg or scratch files staged
git commit -m "chore: take binaries and scratch out of git; tools/; sample video via LFS"
```

---

### Task 6: The Nx plugin moves to `integrations/nx/plugin`

**Files:**
- Move: `magnet_nx_plugin/` → `integrations/nx/plugin/` (74 files)
- Modify: `integrations/nx/plugin/README.md`

**Interfaces:**
- Produces: the plugin source at `integrations/nx/plugin/`. It's frozen: no code changes.

- [ ] **Step 1: Move it**

`mkdir -p integrations/nx && git mv magnet_nx_plugin integrations/nx/plugin`

- [ ] **Step 2: Update the plugin README**

Add a status line at the top: frozen prototype, kept for a future Nx bridge (spec section 6).
Then update it:
- Pin the SDK: built against Nx Meta Server Plugin SDK `6.1.2.42921`
  (`metavms-server_plugin_sdk-6.1.2.42921-universal`); pass it with `-DnxSdkDir=...` or `NX_SDK_DIR`.
- Replace its 4 `magnet_nx_plugin` folder paths with `integrations/nx/plugin`.

- [ ] **Step 3: Verify that it's only a move**

Run: `git diff --cached -M --stat | tail -1`
Expected: 74 files changed. Only `README.md` has insertions or deletions; every other line is a
`=>` rename.

- [ ] **Step 4: Commit**

```bash
git add integrations/nx/plugin/README.md   # the git mv is already staged
git commit -m "refactor: move Nx plugin to integrations/nx/plugin (frozen)"
```

---

### Task 7: The `deploy/` folder

**Files:**
- Move: `docker-compose.yml` → `deploy/docker-compose.yml`; `configs/mediamtx.yml` → `deploy/mediamtx.yml`
- Create: `deploy/.env.example`, `deploy/README.md`
- Test: add `"deploy/.env"` to the `test_local_files_are_ignored` parameters in `tools/tests/test_repo_hygiene.py`

**Interfaces:**
- Consumes: `services/engine/Dockerfile` (Task 1).
- Produces:
  - `deploy/docker-compose.yml`, run from `deploy/`.
  - Environment variables: `ZOO_DATA_DIR` (default `./data`) and `ZOO_VERSION` (default `dev`).
  - Image name `zoo-vision-engine:${ZOO_VERSION}`.
  - Host folders under the data dir: `recordings/`, `snapshots/`, `models/`, `logs/`.

- [ ] **Step 1: Add the ignore test case and run it**

Run: `uvx --from "pytest>=8.3" pytest -q tools/tests/test_repo_hygiene.py`. Expected: PASS.
`.env` is already ignored at any depth, so this case pins the behaviour rather than failing first.

- [ ] **Step 2: Move the files and rewrite the compose paths**

Run `git mv` for both files. In `deploy/docker-compose.yml`:
- Drop the obsolete `version:` key.
- Keep the services, comments, host network and GPU block.
- Set these paths:

| Service | Setting | Value |
|---|---|---|
| mediamtx | config | `./mediamtx.yml:/mediamtx.yml:ro` |
| mediamtx | recordings | `${ZOO_DATA_DIR:-./data}/recordings:/recordings` |
| zoo-ai-engine | build | `../services/engine` |
| zoo-ai-engine | image | `zoo-vision-engine:${ZOO_VERSION:-dev}` |
| zoo-ai-engine | volumes | `../services/engine/configs:/app/configs`, `${ZOO_DATA_DIR:-./data}/models:/app/models`, `${ZOO_DATA_DIR:-./data}/logs:/app/logs`, `${ZOO_DATA_DIR:-./data}/snapshots:/app/snapshots` |

`deploy/.env.example`:
```
# Copy to deploy/.env (git-ignored). Host folder for recordings, snapshots, models and logs.
ZOO_DATA_DIR=./data
# Engine image tag
ZOO_VERSION=dev
```

`deploy/README.md` covers:
- First run:
  1. `cp .env.example .env`
  2. `python3 ../tools/fetch_models.py --dest ./data/models` (use `--from <usb>` offline)
  3. Copy the engine `configs/*.example` files.
  4. `docker compose up -d`
- Windows dev: run a local MediaMTX v1.21.1 binary (downloaded from the MediaMTX GitHub releases
  into the repo root, git-ignored) as `.\mediamtx.exe deploy\mediamtx.yml`.
- `mediamtx.yml` still has the prototype's FFmpeg loop paths. Phase 4 replaces static paths with
  Control API sync.

- [ ] **Step 3: Verify the compose file and the image**

Run from `deploy/`:
```bash
docker compose config --quiet && echo CONFIG_OK
docker compose build zoo-ai-engine
docker run --rm zoo-vision-engine:dev python -c "import main, onnxruntime, torch; print('ok', torch.__version__)"
docker run --rm zoo-vision-engine:dev ls configs
```
Expected:
- `CONFIG_OK`.
- The build succeeds; the first build takes about 10–20 minutes.
- The import check prints `ok 2.x.y+cu126`.
- `ls configs` lists exactly `app_config.yaml.example  cameras.yaml.example  rules`.

Use `docker run`, not `compose run`, because the compose file reserves a GPU that the laptop
doesn't have.

- [ ] **Step 4: Commit**

```bash
git add -A deploy tools/tests   # the two git mv moves are already staged
git commit -m "chore: deploy/ folder with compose, MediaMTX config and data dir"
```

---

### Task 8: CI

**Files:**
- Create: `.github/workflows/engine.yml`, `.github/workflows/repo.yml`

**Interfaces:**
- Consumes: engine commands (Task 1) and `tools/tests` (Tasks 3, 5 and 7).

- [ ] **Step 1: Write the workflows**

`.github/workflows/engine.yml`:
```yaml
name: engine
on:
  push:
    paths: ["services/engine/**", ".github/workflows/engine.yml"]
jobs:
  test:
    runs-on: ubuntu-24.04
    defaults:
      run:
        working-directory: services/engine
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          version: "0.12.10"
          enable-cache: true
          cache-dependency-glob: services/engine/uv.lock
      - run: uv sync --locked
      - run: uv run ruff check .
      - run: uv run pytest -q
```

`.github/workflows/repo.yml` runs on every push, with no path filter, because a binary can be added
anywhere:
```yaml
name: repo
on: [push]
jobs:
  checks:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          version: "0.12.10"
      - run: uvx --from "pytest>=8.3" pytest -q tools/tests
```

- [ ] **Step 2: Run the same commands locally**

Run: `cd services/engine && uv sync --locked && uv run ruff check . && uv run pytest -q`, then
`uvx --from "pytest>=8.3" pytest -q tools/tests` from the repo root. Expected: everything passes.

- [ ] **Step 3: Commit**

```bash
git add .github
git commit -m "ci: engine lint/tests and repo hygiene checks"
```

- [ ] **Step 4: Push (only with the user's OK) and check the runs**

Ask the user before `git push -u origin phase-0-restructure`. The push also uploads the LFS object.
Then run:
`curl -s "https://api.github.com/repos/Aryaputra34/zoo-vision/actions/runs?branch=phase-0-restructure&per_page=5"`
(public repo, no token needed). Expected: the `engine` and `repo` runs end with
`"conclusion": "success"`. The first engine run downloads CUDA torch, roughly 3 GB, so it is slow;
later runs use the cache.

If the user declines the push, record that CI isn't verified yet and continue. Task 11 asks again.

---

### Task 9: Documentation

**Files:**
- Rewrite: `README.md`
- Delete (`git rm`): `INSTALLATION.md` (superseded by `services/engine/README.md`,
  `deploy/README.md` and `docs/07_INSTALLATION_GUIDE.md`)
- Move unchanged (`git mv`): `architecture_best_practice_recommendation.md` → `docs/architecture_best_practice_recommendation.md`
- Modify: `docs/02_MODEL_BUILDING_GUIDE.md`, `docs/05_MODEL_EXPORT_GUIDE.md`,
  `docs/07_INSTALLATION_GUIDE.md`, `docs/08_TESTING_GUIDE.md`, `docs/09_MEDIAMTX_SETUP_AND_TESTING_GUIDE.md`

- [ ] **Step 1: Rewrite the root `README.md`**

- Title: "Zoo Vision (backend)". One paragraph on what the repo holds, with a link to the frontend
  repo `https://github.com/Aryaputra34/zoo-vision-fe`.
- A repo-map table, one row per top-level folder from "Target layout".
- Quick start: engine dev, models, tests, deploy. Each is a link to its folder README plus a
  one-line command.
- The existing guide index (docs/01–09, ADRs), plus a link to the spec and to this plan.

- [ ] **Step 2: Update the how-to guides**

Apply this mapping in the five guides listed under Files:

| Old | New |
|---|---|
| `pip install -r requirements.txt`, manual torch index lines | `cd services/engine && uv sync` |
| `python main.py`, `python test_video.py ...` | `cd services/engine && uv run python main.py` (same for the others) |
| `configs/cameras.yaml`, `configs/app_config.yaml`, `configs/rules/...` | `services/engine/configs/...` |
| `configs/mediamtx.yml` | `deploy/mediamtx.yml` |
| `python export_model.py ...` | `uv run --project services/engine python tools/export_model.py ...` |
| `export_model.py --setup-plate-model`, the plate-model auto-download | `python tools/fetch_models.py` |
| `python pick_coordinates.py ...` | `uv run --project services/engine python tools/pick_coordinates.py ...` |
| `docker compose up` at the repo root | `cd deploy && docker compose up -d` |
| the repo's `mediamtx.exe` | a MediaMTX v1.21.1 download for Windows dev; `bluenviron/mediamtx:1.21.1` in Docker |
| `magnet_nx_plugin/` | `integrations/nx/plugin/` |
| `models/license_plate_detector.onnx` | `services/engine/models/license_plate_detector.onnx` (fetched) |
| `zoo-analytics-web` | `zoo-vision-fe` |

- [ ] **Step 3: Verify that no stale references remain**

Run:
```bash
git grep -n -E "requirements\.txt|model_downloader|setup-plate-model|magnet_nx_plugin/|pip install -r|zoo-analytics-web" -- README.md docs/02_* docs/05_* docs/07_* docs/08_* docs/09_* services tools deploy integrations ':!services/engine/core' ':!services/engine/main.py' ':!services/engine/configs'
```
Expected: no output. Task 10 fixes the engine code comments that this command excludes. Then
re-read each `configs/` mention in the five guides and make sure it is either a full
`services/engine/configs/...` path or explicitly run from `services/engine`.

- [ ] **Step 4: Commit**

```bash
git add -A README.md docs   # the git rm and git mv are already staged
git commit -m "docs: update README and guides for the new layout"
```

---

### Task 10: Frontend repo renamed to `zoo-vision-fe`

**Files:**
- Frontend repo `C:\Users\Magnet Busdev-2\Documents\temp\zoo-analytics-web`:
  - Modify: `package.json`, `package-lock.json`, `README.md`, `docs/API.md`, `.env.example`,
    plus any other hit from Step 3's grep
  - Create: `.github/workflows/ci.yml`
- Backend repo, comments only: `services/engine/configs/app_config.yaml.example:25`,
  `services/engine/core/analytics_dispatcher.py:4`, `services/engine/core/api_server.py:2`,
  `services/engine/core/base_pipeline.py:21`, `services/engine/main.py` (the "Web analytics
  dashboard" comment)

- [ ] **Step 1: The user renames the repo**

Ask the user to open GitHub → `Aryaputra34/zoo-analytics-web` → Settings → General → Repository
name `zoo-vision-fe` → Rename. GitHub redirects the old URL. Wait for them to confirm, then run in
the frontend repo:
`git remote set-url origin https://github.com/Aryaputra34/zoo-vision-fe.git && git fetch origin`.
Expected: the fetch succeeds.

- [ ] **Step 2: Branch**

In the frontend repo, `git status --short` must be empty; if it isn't, ask the user. Then
`git switch -c phase-0-rename`.

- [ ] **Step 3: Rename the references**

1. Run `npm pkg set name=zoo-vision-fe`, then `npm install --package-lock-only`.
2. For every hit of `git grep -n -e zoo-analytics-web -e zoo-monitor -- ':!package-lock.json'`:
   - `zoo-analytics-web` becomes `zoo-vision-fe`.
   - `zoo-monitor` becomes `zoo-vision` (the backend repo).
3. In `.env.example`, update the backend paths:
   - `configs/app_config.yaml` → `services/engine/configs/app_config.yaml`
   - `core/api_server.py` → `services/engine/core/api_server.py`
   - `configs/mediamtx.yml` → `deploy/mediamtx.yml`
4. No other code changes. `src/lib/db.ts` and `src/app/api/*` stay until Phase 3.

- [ ] **Step 4: Add frontend CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npx tsc --noEmit
      - run: npm run build
```

- [ ] **Step 5: Commit, then verify in a clean clone (no `.env.local`, like CI)**

```bash
git add -A && git commit -m "chore: rename to zoo-vision-fe; add CI"
git clone --branch phase-0-rename "C:/Users/Magnet Busdev-2/Documents/temp/zoo-analytics-web" "$TMP/fe-ci-check"
cd "$TMP/fe-ci-check" && npm ci && npm run lint && npx tsc --noEmit && npm run build
```
Here `$TMP` is the session scratchpad. Expected:
- Every command exits 0. Lint printed 6 warnings and 0 errors on 2026-10-08.
- If `npm run build` fails only because the clone has no env file, add the variables from
  `.env.example` with empty values as `env:` on the build step, commit that as a new commit, and
  rerun the check.

- [ ] **Step 6: Update the backend comments**

In the backend repo, replace `zoo-analytics-web` with `zoo-vision-fe` in the five comment
locations listed under Files. Then run `cd services/engine && uv run pytest -q`. Expected: PASS.
```bash
git add services/engine
git commit -m "chore: refer to the frontend as zoo-vision-fe"
```

- [ ] **Step 7: Push the frontend branch (only with the user's OK)**

Run `git push -u origin phase-0-rename` in the frontend repo, then check
`https://api.github.com/repos/Aryaputra34/zoo-vision-fe/actions/runs?branch=phase-0-rename`.
Expected: `ci` ends with `"conclusion": "success"`.

The user may also rename the local folder to `zoo-vision-fe` once editors are closed. It's
optional; nothing depends on it.

---

### Task 11: End-to-end check and hand-off

**Files:** none changed. This task only verifies.

- [ ] **Step 1: Run every suite**

Run: `cd services/engine && uv sync --locked && uv run ruff check . && uv run pytest -q`, then
`uvx --from "pytest>=8.3" pytest -q tools/tests` from the repo root. Expected: all pass.

- [ ] **Step 2: Fresh download from the release**

Confirm with the user that release `models-v1` is published. Then run
`python tools/fetch_models.py --dest "$TMP/fresh-models"`.
Expected: five lines `ok      <file> (fetched)`, exit code 0. Delete `$TMP/fresh-models` afterwards.

- [ ] **Step 3: Compare detection output before and after (same environment)**

Run from the repo root:
```bash
BASE=$(git merge-base HEAD main)
git worktree add ../zoo-vision-baseline "$BASE"
cp services/engine/models/yolo26l.onnx ../zoo-vision-baseline/
RUN="python test_video.py --video sample_data/cars.mp4 --pipeline gate --no-gui --no-anpr --frame-skip 3 --duration 30"
(cd ../zoo-vision-baseline && uv run --project "$OLDPWD/services/engine" $RUN) > scratch/phase0-before.log 2>&1
(cd services/engine && uv run $RUN) > scratch/phase0-after.log 2>&1
for f in before after; do grep "(VehicleGatePipeline)" scratch/phase0-$f.log | sed -E 's/^[0-9]{2}:[0-9]{2}:[0-9]{2} //' > scratch/phase0-$f.events; done
diff scratch/phase0-before.events scratch/phase0-after.events && echo SAME
git worktree remove --force ../zoo-vision-baseline
```
Expected:
- `SAME`.
- Both logs end with `Test video playback ended.`
- The events files contain at least the `Tripwire set:` line.

Both runs use the new uv environment, so any difference comes from the restructure, not from
library versions. The baseline commit has `cars.mp4` as a normal blob, so it needs no LFS.

- [ ] **Step 4: Check the branch state**

Run: `git status --short` (expected: empty) and `git log --oneline production-architecture..HEAD`
(expected: the commits from Tasks 1–10, in order).

- [ ] **Step 5: Hand off**

Ask the user to push if Task 8 didn't, then open the pull requests:
- `https://github.com/Aryaputra34/zoo-vision/compare/main...phase-0-restructure` (includes the spec
  and this plan)
- `https://github.com/Aryaputra34/zoo-vision-fe/compare/main...phase-0-rename`

PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
