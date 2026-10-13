import logging

import pytest

from core import stream_manager as sm
from core.stream_manager import StreamManager, mask_url

SECRET_URL = "rtsp://admin:s3cret@127.0.0.1:1/x"


class _FailingCapture:
    """cv2.VideoCapture stand-in that never opens."""

    def __init__(self, *_args, **_kwargs):
        pass

    def isOpened(self):
        return False

    def release(self):
        pass


class _FlakyCapture:
    """Opens, fails to read twice, then yields frames; behaviour is scripted per read."""

    script: list = []

    def __init__(self, *_args, **_kwargs):
        pass

    def isOpened(self):
        return True

    def read(self):
        return _FlakyCapture.script.pop(0) if _FlakyCapture.script else (True, object())

    def release(self):
        pass


@pytest.fixture
def sleeps(monkeypatch):
    """Record time.sleep instead of sleeping; stop the loop after enough waits."""
    class Waits(list):
        pass

    waits = Waits()
    holder = waits.holder = {}

    def fake_sleep(seconds):
        waits.append(seconds)
        if len(waits) >= holder.get("limit", 6):
            holder["mgr"].is_running = False

    monkeypatch.setattr(sm.time, "sleep", fake_sleep)
    return waits


@pytest.fixture
def failing_capture(monkeypatch):
    monkeypatch.setattr(sm.cv2, "VideoCapture", _FailingCapture)


def _run_loop(mgr, sleeps, limit=6):
    sleeps.holder["mgr"] = mgr
    sleeps.holder["limit"] = limit
    mgr.is_running = True
    mgr._connect()
    mgr._capture_loop()


@pytest.mark.parametrize("url, masked", [
    ("rtsp://admin:s3cret@10.0.0.5:554/main", "rtsp://***@10.0.0.5:554/main"),
    ("rtsp://user:pass@host:554/p", "rtsp://***@host:554/p"),
    ("rtsp://10.0.0.5/main", "rtsp://10.0.0.5/main"),
    ("sample_data/cars.mp4", "sample_data/cars.mp4"),
    ("0", "0"),
    ("rtsp://admin:pa/ss@10.0.0.5/x", "rtsp://***@10.0.0.5/x"),
    ("rtsp://a:p@ss@host/x", "rtsp://***@host/x"),
    ("rtsp://admin@host/x", "rtsp://***@host/x"),
    ("rtsp://host/x?password=x&channel=1", "rtsp://host/x?password=***&channel=1"),
    ("rtsp://host/x?channel=1&Token=abc", "rtsp://host/x?channel=1&Token=***"),
    ("rtsp://host/x?token=abc", "rtsp://host/x?token=***"),
    ("rtsp://host/x?channel=1&subtype=0", "rtsp://host/x?channel=1&subtype=0"),
])
def test_mask_url(url, masked):
    assert mask_url(url) == masked


def test_logs_never_contain_the_password(caplog, failing_capture, sleeps):
    caplog.set_level(logging.DEBUG)
    mgr = StreamManager(SECRET_URL, "cam_x", 5)
    sleeps.holder["mgr"] = mgr
    mgr.start()  # real thread; the fake sleep stops it after a few reconnects
    mgr.thread.join(timeout=5)
    mgr.stop()
    assert "127.0.0.1:1/x" in caplog.text  # the source is still logged, masked
    assert "s3cret" not in caplog.text


def test_reconnect_backoff_doubles_to_30_s(failing_capture, sleeps):
    mgr = StreamManager(SECRET_URL, "cam_x", 5)
    _run_loop(mgr, sleeps)
    assert sleeps == [2, 4, 8, 16, 30, 30]


def test_backoff_resets_after_a_successful_read(monkeypatch, sleeps):
    monkeypatch.setattr(sm.cv2, "VideoCapture", _FlakyCapture)
    _FlakyCapture.script = [(False, None), (False, None), (True, object()), (False, None)]
    mgr = StreamManager("rtsp://10.0.0.5/main", "cam_x", 5)
    _run_loop(mgr, sleeps, limit=8)
    reconnects = [w for w in sleeps if w >= 2]
    assert reconnects == [2, 4, 2]
