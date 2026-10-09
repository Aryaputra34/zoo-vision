import hashlib
import json
import re
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
    (tmp_path / "src").mkdir()
    p = tmp_path / "src" / "m.onnx"
    p.write_bytes(DATA)
    return p


def test_fetch_downloads_and_verifies(src, tmp_path):
    dest = tmp_path / "dest"
    assert fm.fetch(entry(src), dest) == "fetched"
    assert (dest / "m.onnx").read_bytes() == DATA and list(dest.glob(".*.part")) == []


def test_present_file_is_not_fetched_again(src, tmp_path):
    fm.fetch(entry(src), tmp_path / "dest")
    assert fm.fetch(entry(src, url=UNREACHABLE), tmp_path / "dest") == "present"


def test_corrupt_existing_file_is_replaced(src, tmp_path):
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "m.onnx").write_bytes(b"broken")
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
