import os

import pytest

from core.model_store import resolve_model_path


@pytest.fixture
def in_tmp(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ZOO_MODELS_DIR", raising=False)
    return tmp_path


def test_existing_path_is_returned_unchanged(in_tmp):
    (in_tmp / "x.onnx").write_bytes(b"w")
    assert resolve_model_path("x.onnx") == "x.onnx"


def test_bare_name_found_in_models_dir(in_tmp):
    (in_tmp / "models").mkdir()
    (in_tmp / "models" / "yolo26s.onnx").write_bytes(b"w")
    assert resolve_model_path("yolo26s.onnx") == os.path.join("models", "yolo26s.onnx")


def test_models_dir_from_env(in_tmp, monkeypatch):
    data = in_tmp / "data"
    data.mkdir()
    (data / "yolo26s.onnx").write_bytes(b"w")
    monkeypatch.setenv("ZOO_MODELS_DIR", str(data))
    assert resolve_model_path("yolo26s.onnx") == os.path.join(str(data), "yolo26s.onnx")


def test_prefixed_path_falls_back_to_models_dir(in_tmp, monkeypatch):
    data = in_tmp / "data"
    data.mkdir()
    (data / "license_plate_detector.onnx").write_bytes(b"w")
    monkeypatch.setenv("ZOO_MODELS_DIR", str(data))
    assert resolve_model_path("models/license_plate_detector.onnx") == os.path.join(
        str(data), "license_plate_detector.onnx")


def test_missing_pt_passes_through(in_tmp):
    assert resolve_model_path("yolo11s.pt") == "yolo11s.pt"


def test_missing_onnx_raises_with_fetch_hint(in_tmp):
    with pytest.raises(FileNotFoundError, match="tools/fetch_models.py"):
        resolve_model_path("yolo26s.onnx")
