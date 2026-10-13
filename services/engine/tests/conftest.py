import threading
from pathlib import Path

import pytest
import torch
import ultralytics
import yaml
from core.messages import validate
from core.model_pool import ModelPool
from ultralytics.engine.results import Results

ENGINE_DIR = Path(__file__).resolve().parents[1]

COCO_NAMES = yaml.safe_load(
    (Path(ultralytics.__file__).parent / "cfg/datasets/coco.yaml").read_text(encoding="utf-8"))["names"]


@pytest.fixture(autouse=True)
def engine_cwd(monkeypatch):
    """Rule and model paths in configs are relative to the engine root."""
    monkeypatch.chdir(ENGINE_DIR)


class FakeYOLO:
    """
    Stands in for ultralytics.YOLO: loads no weights, detects nothing. Class-level records:
    `loads` (constructions), `batches` (frames per call), `kwargs` (keyword arguments per call).
    `gate` blocks __call__ and `load_gate` blocks construction until set (both set by default).
    Two overlapping calls fail the test (see `overlaps`, checked by the fake_yolo fixture).
    """

    boxes = torch.zeros((0, 6))  # N x 6 (x1, y1, x2, y2, conf, cls) returned for every frame
    loads = 0
    batches: list = []
    kwargs: list = []
    overlaps = 0
    gate = threading.Event()
    load_gate = threading.Event()
    gate.set()
    load_gate.set()
    _record = threading.Lock()

    @classmethod
    def reset(cls):
        cls.boxes = torch.zeros((0, 6))
        cls.loads, cls.overlaps = 0, 0
        cls.batches, cls.kwargs = [], []
        cls.gate, cls.load_gate = threading.Event(), threading.Event()
        cls.gate.set()
        cls.load_gate.set()

    def __init__(self, model=None, task=None):
        type(self).load_gate.wait(10)
        if model is not None and "missing" in str(model):
            raise FileNotFoundError(model)
        with type(self)._record:
            type(self).loads += 1
        self._busy = threading.Lock()  # overlap is per model object: separate models may run at once
        self.model_name, self.names = model, dict(COCO_NAMES)

    def __call__(self, source, **kwargs):
        cls = type(self)
        frames = list(source) if isinstance(source, (list, tuple)) else [source]
        if not self._busy.acquire(blocking=False):
            cls.overlaps += 1
            raise AssertionError("FakeYOLO was called by two threads at once")
        try:
            with cls._record:
                cls.batches.append(len(frames))
                cls.kwargs.append(kwargs)
            cls.gate.wait(10)
            results = [Results(orig_img=f, path="", names=self.names, boxes=cls.boxes) for f in frames]
        finally:
            self._busy.release()
        return results


class FakeReader:
    """Stands in for easyocr.Reader (which downloads OCR weights on construction)."""

    def __init__(self, *args, **kwargs):
        pass

    def readtext(self, *args, **kwargs):
        return []


@pytest.fixture
def fake_yolo(monkeypatch):
    FakeYOLO.reset()
    monkeypatch.setattr("core.base_pipeline.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.easyocr.Reader", FakeReader)
    # pipelines need no weights on disk; ANPR keeps the real lookup (see the gate wiring test)
    monkeypatch.setattr("core.base_pipeline.resolve_model_path", lambda name, models_dir=None: name)
    yield FakeYOLO
    FakeYOLO.gate.set()
    FakeYOLO.load_gate.set()
    assert FakeYOLO.overlaps == 0, "FakeYOLO was called by two threads at once"


@pytest.fixture
def fake_pool(fake_yolo, monkeypatch):
    """A ModelPool that loads FakeYOLO and resolves model names to themselves."""
    monkeypatch.setattr("core.model_pool.resolve_model_path", lambda name, models_dir=None: name)
    pool = ModelPool("cpu", loader=FakeYOLO)
    yield pool
    fake_yolo.gate.set()
    fake_yolo.load_gate.set()
    pool.close()


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
