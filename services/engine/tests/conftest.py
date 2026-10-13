from pathlib import Path

import pytest
import torch
import ultralytics
import yaml
from core.messages import validate
from ultralytics.engine.results import Results

ENGINE_DIR = Path(__file__).resolve().parents[1]

COCO_NAMES = yaml.safe_load(
    (Path(ultralytics.__file__).parent / "cfg/datasets/coco.yaml").read_text(encoding="utf-8"))["names"]


@pytest.fixture(autouse=True)
def engine_cwd(monkeypatch):
    """Rule and model paths in configs are relative to the engine root."""
    monkeypatch.chdir(ENGINE_DIR)


class FakeYOLO:
    """Stands in for ultralytics.YOLO: loads no weights, detects nothing."""

    boxes = torch.zeros((0, 6))  # N x 6 (x1, y1, x2, y2, conf, cls) returned for every frame

    def __init__(self, model=None, task=None):
        self.model_name, self.names = model, dict(COCO_NAMES)

    def __call__(self, source, **kwargs):
        return [Results(orig_img=source, path="", names=self.names, boxes=type(self).boxes)]


class FakeReader:
    """Stands in for easyocr.Reader (which downloads OCR weights on construction)."""

    def __init__(self, *args, **kwargs):
        pass

    def readtext(self, *args, **kwargs):
        return []


@pytest.fixture
def fake_yolo(monkeypatch):
    monkeypatch.setattr("core.base_pipeline.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.easyocr.Reader", FakeReader)
    # pipelines need no weights on disk; ANPR keeps the real lookup (see the gate wiring test)
    monkeypatch.setattr("core.base_pipeline.resolve_model_path", lambda name, models_dir=None: name)
    return FakeYOLO


class RecordingStream:
    """Stands in for EventStream: a message that breaks the contract fails the test."""

    def __init__(self):
        self.sent = []

    def send(self, msg):
        validate(msg)
        self.sent.append(msg)


@pytest.fixture
def stream():
    return RecordingStream()
