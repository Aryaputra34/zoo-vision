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
                                  "services/engine/models/yolo26s.onnx", "scratch/notes.py",
                                  "deploy/.env"])
def test_local_files_are_ignored(path):
    assert subprocess.run(["git", "check-ignore", "-q", path], cwd=REPO).returncode == 0


# Operator config holds camera passwords and API keys. Checked here because repo.yml runs on every push,
# including a .gitignore-only change that the path-filtered engine workflow would not see.
@pytest.mark.parametrize("path", ["services/engine/configs/cameras.yaml", "services/engine/configs/app_config.yaml",
                                  "services/engine/.env", "services/engine/configs/cameras.yaml.bak",
                                  "services/engine/configs/cameras_site2.yaml"])
def test_operator_config_is_ignored(path):
    assert subprocess.run(["git", "check-ignore", "-q", path], cwd=REPO).returncode == 0


@pytest.mark.parametrize("path", ["services/engine/configs/cameras.yaml.example",
                                  "services/engine/configs/app_config.yaml.example",
                                  "services/engine/configs/rules/vehicle_gate.yaml"])
def test_config_examples_and_rules_stay_tracked(path):
    # --no-index: test the ignore patterns themselves, not just the fact that the file is tracked
    assert subprocess.run(["git", "check-ignore", "--no-index", "-q", path], cwd=REPO).returncode == 1


def test_model_manifest_is_not_ignored():
    assert subprocess.run(["git", "check-ignore", "-q", "services/engine/models/manifest.json"],
                          cwd=REPO).returncode == 1
