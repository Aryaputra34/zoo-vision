import json
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import torch
import ultralytics
import yaml
from core.base_pipeline import CameraInfo
from core.messages import validate
from core.model_pool import ModelPool
from core.settings import parse_settings
from nx_integration.nx_client import NxClient
from usecases import create_pipeline
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
    `load_started` (constructions begun, counted before `load_gate`), `loads` (constructions finished),
    `batches` (frames per call), `kwargs` (keyword arguments per call).
    `gate` blocks __call__ and `load_gate` blocks construction until set (both set by default).
    A model whose path holds "missing", or is in `unavailable`, fails to load (FileNotFoundError).
    Two overlapping calls fail the test (see `overlaps`, checked by the fake_yolo fixture).
    """

    boxes = torch.zeros((0, 6))  # N x 6 (x1, y1, x2, y2, conf, cls) returned for every frame
    load_started = 0
    loads = 0
    batches: list = []
    kwargs: list = []
    exports: list = []
    unavailable: set = set()
    overlaps = 0
    gate = threading.Event()
    load_gate = threading.Event()
    gate.set()
    load_gate.set()
    _record = threading.Lock()

    @classmethod
    def reset(cls):
        cls.boxes = torch.zeros((0, 6))
        cls.load_started, cls.loads, cls.overlaps = 0, 0, 0
        cls.batches, cls.kwargs, cls.exports = [], [], []
        cls.unavailable = set()
        cls.gate, cls.load_gate = threading.Event(), threading.Event()
        cls.gate.set()
        cls.load_gate.set()

    def __init__(self, model=None, task=None):
        with type(self)._record:
            type(self).load_started += 1
        type(self).load_gate.wait(10)
        if model is not None and ("missing" in str(model) or str(model) in type(self).unavailable):
            raise FileNotFoundError(model)
        with type(self)._record:
            type(self).loads += 1
        self._busy = threading.Lock()  # overlap is per model object: separate models may run at once
        self.model_name, self.names = model, dict(COCO_NAMES)

    def export(self, **kwargs):
        """Writes "<stem>.onnx" next to the source model and returns its path (records the arguments)."""
        type(self).exports.append(kwargs)
        out = Path(str(self.model_name)).with_suffix(".onnx")
        out.write_bytes(b"fake onnx")
        return str(out)

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
    monkeypatch.setattr("core.anpr_engine.YOLO", FakeYOLO)
    monkeypatch.setattr("core.anpr_engine.easyocr.Reader", FakeReader)
    # ANPR keeps the real model lookup (see the gate wiring test)
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


EXAMPLES_DIR = ENGINE_DIR.parents[1] / "packages" / "contracts" / "usecases"


def example_dict(use_case: str) -> dict:
    """The settings the prototype's rule file for `use_case` produced (the contract's current_rules example)."""
    path = EXAMPLES_DIR / use_case / "examples" / "settings" / "valid" / "current_rules.json"
    return json.loads(path.read_text(encoding="utf-8"))


def example_settings(use_case: str):
    return parse_settings(use_case, example_dict(use_case), strict=False)


def make_pipeline(use_case: str, settings=None, stream=None):
    """A pipeline built through the registry on a FakeYOLO. `settings` is a model or a dict (parsed leniently)."""
    if settings is None:
        settings = example_settings(use_case)
    elif isinstance(settings, dict):
        settings = parse_settings(use_case, settings, strict=False)
    pipeline = create_pipeline(
        CameraInfo("cam_test", "Test Cam"), use_case, settings, FakeYOLO(),
        device="cpu", nx_client=NxClient(mock_mode=True),
    )
    pipeline.events = stream
    return pipeline


def table_change(status):
    return {"tableId": "T1", "tableName": "Table 1", "oldStatus": "", "status": status, "dwellSec": 0, "timestampMs": 1}


# --- Camera workers and the supervisor (test_worker.py, test_supervisor.py) ---

def wait_until(cond, timeout: float = 2.0) -> bool:
    """Polls `cond` every 10 ms until it is truthy (True) or `timeout` seconds have passed (False)."""
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)
    return True


class FakeClock:
    """An epoch clock the test sets by hand."""

    def __init__(self, t: float = 1_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


LIVE_FRAME = np.zeros((180, 320, 3), np.uint8)
TABLES = {  # normalized polygons; on LIVE_FRAME a person box at PEOPLE[id] sits in table id
    "T1": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.5], [0.1, 0.5]],
    "T2": [[0.6, 0.1], [0.9, 0.1], [0.9, 0.5], [0.6, 0.5]],
}
PEOPLE = {"T1": (50, 25, 75, 75), "T2": (200, 25, 225, 75)}


def people_in(*table_ids):
    """FakeYOLO.boxes with one person in each named table."""
    return torch.tensor([[*PEOPLE[t], 0.9, 0.0] for t in table_ids]) if table_ids else torch.zeros((0, 6))


def sessions(stream, message: str, camera_id: str = "cam1") -> list:
    """The table_session interval messages of one kind ("interval_open" / "interval_close") a camera sent."""
    return [m for m in stream.sent
            if m["message"] == message and m.get("kind") == "table_session" and m["cameraId"] == camera_id]


def opened_tables(stream, camera_id: str = "cam1") -> set:
    return {m["subjectId"] for m in sessions(stream, "interval_open", camera_id)}


def table_dict(*table_ids, **changes) -> dict:
    """API-filled restaurant_table settings: the example's, with tables from TABLES whose sessions open on the
    first frame with a person."""
    d = example_dict("restaurant_table")
    d["tables"] = [{"id": t, "name": f"Table {t}", "capacity": 4, "polygon": TABLES[t]} for t in table_ids]
    d["dwell_time"] = {"enabled": True, "min_occupied_sec": 0.0, "empty_debounce_sec": 2.0, "alert_dwell_sec": 3600.0}
    d.update(changes)
    return d


def cfg(**over):
    """A restaurant_table CameraConfig, version 1, on model a.onnx."""
    from core.camera_config import CameraConfig

    fields = dict(
        id="cam1", name="Cam 1", use_case="restaurant_table", version=1, settings=table_dict("T1", "T2"),
        source_url="rtsp://admin:s3cret@10.0.0.5/main", target_fps=5, model_path="a.onnx", imgsz=1920,
        nx_camera_id=None,
    )
    fields.update(over)
    return CameraConfig(**fields)


class FakeStream:
    """Stands in for StreamManager. While started, get_frame() serves LIVE_FRAME with a new timestamp at most every
    `period` s of real time (epoch ms from `clock`, strictly increasing); with deliver=False it never has a frame.
    Counts its starts, stops and get_frame() calls (`reads`)."""

    def __init__(self, source, camera_id, target_fps, *, clock=time.time, deliver=True, period=0.01):
        self.source, self.camera_id, self.target_fps = source, camera_id, target_fps
        self.clock, self.deliver, self.period = clock, deliver, period
        self.starts = self.stops = self.reads = 0
        self._lock = threading.Lock()
        self._ts = 0
        self._minted = 0.0

    def start(self):
        self.starts += 1

    def stop(self):
        self.stops += 1

    def get_frame(self):
        with self._lock:
            self.reads += 1
            if not self.deliver or not self.starts or self.stops:
                return None, 0
            now = time.monotonic()
            if not self._ts or now - self._minted >= self.period:
                self._ts = max(self._ts + 1, int(self.clock() * 1000))
                self._minted = now
            return LIVE_FRAME, self._ts


class Streams:
    """A stream_factory that makes FakeStreams and keeps them. Streams of the cameras in `silent`, and of the sources
    in `silent_sources`, never deliver."""

    def __init__(self):
        self.made: list[FakeStream] = []
        self.clock = time.time
        self.silent: set[str] = set()
        self.silent_sources: set[str] = set()
        self.period = 0.01  # real seconds between two new frames
        self.fail_starts = 0  # the next this many calls raise, like a stream that cannot be created

    def __call__(self, source, camera_id, target_fps):
        if self.fail_starts > 0:
            self.fail_starts -= 1
            raise OSError("cannot create the stream")
        deliver = camera_id not in self.silent and source not in self.silent_sources
        s = FakeStream(source, camera_id, target_fps, clock=self.clock, deliver=deliver, period=self.period)
        self.made.append(s)
        return s

    def started(self) -> int:
        return sum(s.starts for s in self.made)

    def stopped(self) -> int:
        return sum(s.stops for s in self.made)


@pytest.fixture
def streams():
    return Streams()


@pytest.fixture
def deps(fake_pool, streams, stream):
    from core.worker import WorkerDeps

    return WorkerDeps(pool=fake_pool, events=stream, snapshots=None, nx_client=NxClient(mock_mode=True),
                      device="cpu", stream_factory=streams)


def camera_threads() -> list[str]:
    """Names of the live threads a camera worker started (its own, its loaders and stream starters)."""
    return [t.name for t in threading.enumerate() if t.name.startswith("cam-")]


@pytest.fixture
def make_worker(deps, fake_yolo):
    """Builds CameraWorkers on `deps`; at teardown opens the FakeYOLO gates, stops them, and checks that their
    threads end (a helper still loading ends on its own once the gate is open)."""
    from core.worker import CameraWorker

    made = []

    def make(config=None, *, clock=time.time):
        w = CameraWorker(config or cfg(), deps, clock=clock)
        made.append(w)
        return w

    yield make
    fake_yolo.gate.set()
    fake_yolo.load_gate.set()
    for w in made:
        w.stop("engine_stop", timeout=5.0)
    assert wait_until(lambda: camera_threads() == [])
