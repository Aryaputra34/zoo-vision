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
    assert subprocess.run(["git", "check-ignore", "-q", "services/engine/models/manifest.json"],
                          cwd=REPO).returncode == 1
