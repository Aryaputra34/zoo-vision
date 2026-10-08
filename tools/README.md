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
