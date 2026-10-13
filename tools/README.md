# Tools

Scripts for setting up and maintaining a Zoo Vision install. Run them from the repo root.

## fetch_models.py: model weights

Model weights are not stored in git. `services/engine/models/manifest.json` lists each model file
with its sha256 and size, and the download link in the GitHub release `models-v1`.
`fetch_models.py` downloads the files and checks every checksum. It uses only the Python standard
library, so a server's system `python3` is enough.

```bash
python3 tools/fetch_models.py                           # dev: into services/engine/models/
python3 tools/fetch_models.py --dest deploy/data/models # server: the deployment's model folder
python3 tools/fetch_models.py --from /media/usb/models  # offline site: copy from a folder, no network
python3 tools/fetch_models.py --only yolo26s.onnx       # one model (repeatable)
```

- A file that is already present with the right checksum is skipped.
- A download or copy with the wrong checksum is deleted and reported as `FAILED`. The previous file
  is never half-overwritten.
- Exit code: 0 when every model is ok, 1 when any failed, 2 when `--only` names an unknown file.

**Adding a model:**
1. Upload the file to a release, either `models-v1` or a new `models-vN`.
2. Add an entry to the manifest with `sha256sum <file>`, its size in bytes and the download link.
3. Reference it from a rule file (`model_name:` in `services/engine/configs/rules/*.yaml`).

The engine tests fail if a rule file names a model that isn't in the manifest.

**Customer-specific models** (for example trained on the park's footage) never go in a public
release. Install them with `--from <folder>` from a file share or USB stick.

## export_model.py: convert a model

Exports a YOLO `.pt` model to ONNX, OpenVINO, TensorRT, TorchScript or TFLite (interactive wizard
when run without `--model`). It needs the engine's Python environment. `--model` is a path; fetched weights are in
`services/engine/models/`, and the export is written next to the `.pt` (so exporting there replaces a fetched file of
the same name until the next `fetch_models.py` run):

```bash
uv run --project services/engine python tools/export_model.py --model services/engine/models/yolo26s.pt --format onnx --imgsz 736 1280
uv run --project services/engine python tools/export_model.py --list    # local .pt files
```

## pick_coordinates.py: draw zones on a frame

Interactive picker for tripwire lines, polygons and restaurant tables on a video frame. With
`--update-yaml` (or in tables mode) it writes the coordinates into
`services/engine/configs/rules/*.yaml`. Phase 3's web zone editor replaces it.

```bash
uv run --project services/engine python tools/pick_coordinates.py --help
```

## import_yaml_config.py: one-off import of cameras.yaml

Creates each camera of the engine's `cameras.yaml` through `POST /api/v1/cameras`, with the settings the
engine runs today: the rule file, then the inline `rules`, then the inline `roi`, merged as
`BasePipeline` does. Keys the use case's settings schema doesn't define are dropped and listed per
camera as JSON pointers. Stream URLs are masked in all output.

```bash
uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml.example --dry-run
export ZOO_API_TOKEN=zv_...    # a SUPERADMIN API token
uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml [--api http://127.0.0.1:3001]
```

- A camera that already exists (409) is skipped. A rejected one prints the status and the API's reply.
- Exit code: 0 when every camera was created or skipped, 1 when any failed, 2 when the token is missing.
- The tools tests need `pyyaml`, `jsonschema` and `requests`:
  `uvx --from "pytest>=8.3" --with pyyaml --with jsonschema --with requests pytest -q tools/tests`
