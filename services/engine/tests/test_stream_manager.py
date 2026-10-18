import logging
import time

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
    """Opens; each read follows `script`, then yields frames. Records seeks (`seeks`) and opens (`opens`)."""

    script: list = []
    seeks: list = []
    opens = 0

    def __init__(self, *_args, **_kwargs):
        _FlakyCapture.opens += 1

    def isOpened(self):
        return True

    def read(self):
        return _FlakyCapture.script.pop(0) if _FlakyCapture.script else (True, object())

    def set(self, prop, value):
        _FlakyCapture.seeks.append(value)
        return True

    def release(self):
        pass


@pytest.fixture
def flaky_capture(monkeypatch):
    _FlakyCapture.script, _FlakyCapture.seeks, _FlakyCapture.opens = [], [], 0
    monkeypatch.setattr(sm.cv2, "VideoCapture", _FlakyCapture)
    return _FlakyCapture


@pytest.fixture
def sleeps(monkeypatch):
    """Record the reader's waits instead of waiting; stop the manager after enough waits."""
    class Waits(list):
        pass

    waits = Waits()
    holder = waits.holder = {}

    def fake_wait(mgr, seconds):
        waits.append(seconds)
        if len(waits) >= holder.get("limit", 6):
            mgr._stop_event.set()
        return mgr._stop_event.is_set()

    monkeypatch.setattr(StreamManager, "_wait", fake_wait)
    return waits


@pytest.fixture
def failing_capture(monkeypatch):
    monkeypatch.setattr(sm.cv2, "VideoCapture", _FailingCapture)


def _run_loop(mgr, sleeps, limit=6):
    sleeps.holder["limit"] = limit
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
    ("C:/videos/gate.mp4", "C:/videos/gate.mp4"),
    # a credential that holds '#', '?' or '@', or sits in a query value: everything up to the last '@' goes
    ("rtsp://u:p#x@h/s", "rtsp://***@h/s"),
    ("rtsp://u:p?x@h/s", "rtsp://***@h/s"),
    ("rtsp://h/s?url=rtsp://a:b@c/", "rtsp://***@c/"),
    # any query parameter whose name holds a secret word
    ("rtsp://h/s?access_token=abc&channel=1", "rtsp://h/s?access_token=***&channel=1"),
    ("rtsp://h/s?api_key=abc", "rtsp://h/s?api_key=***"),
    ("rtsp://h/s?apikey=abc", "rtsp://h/s?apikey=***"),
    ("https://h/s?X-Amz-Signature=abc&X-Amz-Credential=def", "https://h/s?X-Amz-Signature=***&X-Amz-Credential=***"),
    ("http://h/s;jsessionid=abc", "http://h/s;jsessionid=***"),
    # XMEye / Sofia: the credentials are parameters of the path, and the rest of the path goes with them
    ("rtsp://10.0.0.5:554/user=admin_password=Secr3t_channel=1_stream=0.sdp", "rtsp://10.0.0.5:554/user=admin_password=***"),
    ("rtsp://10.0.0.5/live/pwd=Secr3t_channel=1", "rtsp://10.0.0.5/live/pwd=***"),
    # a secret value runs to the next '&': '#' and ';' inside it do not end it
    ("rtsp://10.0.0.5/live?password=ab#cd&channel=1", "rtsp://10.0.0.5/live?password=***&channel=1"),
    ("rtsp://10.0.0.5/live?password=ab;cd&channel=1", "rtsp://10.0.0.5/live?password=***&channel=1"),
    # leading whitespace does not hide the scheme
    (" rtsp://admin:pw@10.0.0.5/s", " rtsp://***@10.0.0.5/s"),
    ("	rtsp://admin:pw@10.0.0.5/s", "	rtsp://***@10.0.0.5/s"),
    ("  rtsp://10.0.0.5/live?token=abc", "  rtsp://10.0.0.5/live?token=***"),
    # a '?' inside a path credential does not end it: the tail goes too
    ("rtsp://h/user=admin_password=ab?cd_channel=1", "rtsp://h/user=admin_password=***"),
    ("rtsp://h/live?pw=Secr3t&channel=1", "rtsp://h/live?pw=***&channel=1"),
    # nothing secret-named: unchanged, and a path that merely contains a key-like word without '='
    ("rtsp://10.0.0.5:554/stream_key/main", "rtsp://10.0.0.5:554/stream_key/main"),
])
def test_mask_url(url, masked):
    assert mask_url(url) == masked


def test_logs_never_contain_the_password(caplog, failing_capture, sleeps):
    caplog.set_level(logging.DEBUG)
    mgr = StreamManager(SECRET_URL, "cam_x", 5)
    mgr.start()  # real thread; the fake wait stops it after a few reconnects
    mgr.thread.join(timeout=5)
    mgr.stop()
    assert "127.0.0.1:1/x" in caplog.text  # the source is still logged, masked
    assert "s3cret" not in caplog.text


def test_reconnect_backoff_doubles_to_30_s(failing_capture, sleeps):
    mgr = StreamManager(SECRET_URL, "cam_x", 5)
    _run_loop(mgr, sleeps)
    assert sleeps == [2, 4, 8, 16, 30, 30]


class _RecordingCapture:
    """cv2.VideoCapture stand-in that never opens; records the time of every open."""

    opens: list = []

    def __init__(self, *_args, **_kwargs):
        _RecordingCapture.opens.append(time.monotonic())

    def isOpened(self):
        return False

    def release(self):
        pass


@pytest.fixture
def recording_capture(monkeypatch):
    _RecordingCapture.opens = []
    monkeypatch.setattr(sm.cv2, "VideoCapture", _RecordingCapture)
    return _RecordingCapture.opens


def test_stop_interrupts_the_reconnect_backoff(recording_capture):
    mgr = StreamManager("rtsp://10.0.0.5/main", "cam_x", 5)
    mgr.start()  # the first open fails: the reader waits 2 s before the next one
    time.sleep(0.2)
    started = time.monotonic()
    mgr.stop()
    assert time.monotonic() - started < 0.5
    assert not mgr.thread.is_alive()
    assert len(recording_capture) == 1  # no open after the stop


def test_a_stopped_manager_never_connects_again(recording_capture):
    mgr = StreamManager("rtsp://10.0.0.5/main", "cam_x", 5)
    mgr.start()
    mgr.stop()
    mgr._connect()  # what the reader would do if it got past its wait
    assert len(recording_capture) == 1


def test_a_live_url_decodes_on_one_thread_a_file_keeps_the_defaults(monkeypatch):
    calls = []

    class _ArgsCapture(_RecordingCapture):
        def __init__(self, *args, **_kwargs):
            calls.append(args)

    monkeypatch.setattr(sm.cv2, "VideoCapture", _ArgsCapture)
    StreamManager("rtsp://10.0.0.5/main", "cam_x", 5)._connect()
    StreamManager("clips/gate.mp4", "cam_y", 5)._connect()
    assert calls[0] == ("rtsp://10.0.0.5/main", sm.cv2.CAP_FFMPEG, [sm.cv2.CAP_PROP_N_THREADS, 1])
    assert calls[1] == ("clips/gate.mp4",)


def test_backoff_resets_after_a_successful_read(flaky_capture, sleeps):
    flaky_capture.script = [(False, None), (False, None), (True, object()), (False, None)]
    mgr = StreamManager("rtsp://10.0.0.5/main", "cam_x", 5)
    _run_loop(mgr, sleeps, limit=8)
    reconnects = [w for w in sleeps if w >= 2]
    assert reconnects == [2, 4, 2]


@pytest.mark.parametrize("source", ["rtsps://10.0.0.5/main", "RTSP://10.0.0.5/main", "http://10.0.0.5/video.mjpg"])
def test_a_failed_read_of_a_network_stream_reconnects(flaky_capture, sleeps, source):
    flaky_capture.script = [(False, None)]
    mgr = StreamManager(source, "cam_x", 5)
    _run_loop(mgr, sleeps, limit=2)
    assert flaky_capture.seeks == [] and flaky_capture.opens == 2  # reconnected, never sought
    assert sleeps[0] == 2


@pytest.mark.parametrize("source", ["sample_data/cars.mp4", "C:/videos/gate.mp4", "file:///C:/videos/gate.mp4"])
def test_a_file_loops_back_to_its_start(flaky_capture, sleeps, source):
    flaky_capture.script = [(False, None)]
    mgr = StreamManager(source, "cam_x", 5)
    _run_loop(mgr, sleeps, limit=2)
    assert flaky_capture.seeks == [0] and flaky_capture.opens == 1


class _NumberedCapture:
    """An endless video whose frames are their own numbers. Reports `fps` as CAP_PROP_FPS; a read takes
    `read_cost` s of virtual time (a slow decoder). Counts grabs (frames skipped without decoding)."""

    fps = 10.0
    read_cost = 0.0
    clock = None
    grabs = 0

    def __init__(self, *_args, **_kwargs):
        self.pos = 0

    def isOpened(self):
        return True

    def get(self, prop):
        return _NumberedCapture.fps if prop == sm.cv2.CAP_PROP_FPS else 0.0

    def read(self):
        if _NumberedCapture.clock is not None:
            _NumberedCapture.clock.t += _NumberedCapture.read_cost
        self.pos += 1
        return True, self.pos - 1

    def grab(self):
        _NumberedCapture.grabs += 1
        self.pos += 1
        return True

    def set(self, prop, value):
        self.pos = int(value)
        return True

    def release(self):
        pass


class _VirtualTime:
    def __init__(self):
        self.t = 0.0
        self.until = 2.0

    def __call__(self):
        return self.t


@pytest.fixture
def virtual_time(monkeypatch):
    """The reader's waits advance a virtual clock instead of sleeping; the manager stops at `until`."""
    vt = _VirtualTime()
    _NumberedCapture.fps, _NumberedCapture.read_cost, _NumberedCapture.clock, _NumberedCapture.grabs = 10.0, 0, vt, 0
    monkeypatch.setattr(sm.cv2, "VideoCapture", _NumberedCapture)

    def fake_wait(mgr, seconds):
        vt.t += seconds
        if vt.t >= vt.until:
            mgr._stop_event.set()
        return mgr._stop_event.is_set()

    monkeypatch.setattr(StreamManager, "_wait", fake_wait)
    return vt


def _play(source, vt, target_fps=30):
    mgr = StreamManager(source, "cam_x", target_fps)
    mgr._clock = vt
    mgr._connect()
    mgr._capture_loop()
    frame, _ = mgr.get_frame()
    return frame  # the number of the last frame handed out, at virtual time `until`


def test_a_file_plays_at_its_own_frame_rate(virtual_time):
    assert 18 <= _play("sample_data/cars.mp4", virtual_time) <= 21  # 2 s of a 10 fps file: about frame 20
    assert _NumberedCapture.grabs == 0


def test_a_file_read_too_slowly_skips_frames_instead_of_drifting(virtual_time):
    _NumberedCapture.read_cost = 0.25  # each decode takes 2.5 frames of a 10 fps file
    assert 15 <= _play("sample_data/cars.mp4", virtual_time) <= 22  # still about frame 20 after 2 s
    assert _NumberedCapture.grabs > 0


@pytest.mark.parametrize("reported", [0.0, float("nan"), float("inf")])
def test_a_file_without_a_usable_frame_rate_plays_at_25_fps(virtual_time, reported):
    _NumberedCapture.fps = reported
    virtual_time.until = 1.0
    assert 23 <= _play("sample_data/cars.mp4", virtual_time) <= 26


def test_a_network_stream_is_not_paced(virtual_time):
    assert _play("rtsp://10.0.0.5/main", virtual_time) > 100  # read as fast as it comes (here: every 5 ms yield)
