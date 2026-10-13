import os
import time
import uuid
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
import redis
from core.status import StatusPublisher

pytestmark = pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs REDIS_URL")


@pytest.fixture
def r():
    client = redis.Redis.from_url(os.environ["REDIS_URL"])
    yield client
    client.close()


def fake_worker(now, *, last_frame_ago=3.0, state="running", frame=None, **over):
    camera_id = over.pop("id", f"cam_{uuid.uuid4().hex[:8]}")
    w = SimpleNamespace(
        id=camera_id, config=SimpleNamespace(use_case="vehicle_gate"), pipeline=SimpleNamespace(live={"in": 2}),
        state=state, fps=4.94, last_frame_at=None if last_frame_ago is None else now - last_frame_ago,
        started_at=now - 60, applied_version=7, config_error=None, restarts=1, latest_raw=frame)
    for k, v in over.items():
        setattr(w, k, v)
    return w


def publisher(r, workers, now):
    return StatusPublisher(r, lambda: workers, engine_group="park", boot_id="boot1", clock=lambda: now)


def test_status_hash_fields_and_expiry_anchored_at_the_last_frame(r):
    now = time.time()
    w = fake_worker(now)
    try:
        publisher(r, [w], now).publish_status(now)
        h = {k.decode(): v.decode() for k, v in r.hgetall(f"cam:{w.id}:status").items()}
        assert h == {
            "state": "running", "fps": "4.9", "lastFrameAt": str(int((now - 3) * 1000)), "appliedVersion": "7",
            "configError": "", "useCase": "vehicle_gate", "engineGroup": "park", "bootId": "boot1", "restarts": "1",
            "live": '{"in": 2}', "updatedAt": str(int(now * 1000)),
        }
        assert 11_000 <= r.pttl(f"cam:{w.id}:status") <= 12_000
    finally:
        r.delete(f"cam:{w.id}:status")


def test_before_the_first_frame_the_fields_are_empty_and_the_worker_start_anchors_the_expiry(r):
    now = time.time()
    w = fake_worker(now, last_frame_ago=None, state="starting", applied_version=None, started_at=now - 4)
    w.pipeline = None
    try:
        publisher(r, [w], now).publish_status(now)
        h = {k.decode(): v.decode() for k, v in r.hgetall(f"cam:{w.id}:status").items()}
        assert (h["state"], h["lastFrameAt"], h["appliedVersion"], h["live"]) == ("starting", "", "", "{}")
        assert 10_000 <= r.pttl(f"cam:{w.id}:status") <= 11_000
    finally:
        r.delete(f"cam:{w.id}:status")


def test_state_is_reconnecting_after_5_s_without_a_frame(r):
    now = time.time()
    fresh, old = fake_worker(now, last_frame_ago=4.0), fake_worker(now, last_frame_ago=6.0)
    try:
        publisher(r, [fresh, old], now).publish_status(now)
        assert r.hget(f"cam:{fresh.id}:status", "state") == b"running"
        assert r.hget(f"cam:{old.id}:status", "state") == b"reconnecting"
    finally:
        r.delete(f"cam:{fresh.id}:status", f"cam:{old.id}:status")


def test_nothing_is_written_15_s_after_the_last_frame(r):
    now = time.time()
    w = fake_worker(now, last_frame_ago=16.0, started_at=now - 60)
    publisher(r, [w], now).publish_status(now)
    assert r.exists(f"cam:{w.id}:status") == 0


def test_a_stopped_worker_is_skipped(r):
    now = time.time()
    w = fake_worker(now, state="stopped")
    publisher(r, [w], now).publish_status(now)
    assert r.exists(f"cam:{w.id}:status") == 0


def test_the_status_keys_are_rewritten_after_redis_loses_them(r):
    now = time.time()
    w = fake_worker(now)
    p = publisher(r, [w], now)
    try:
        p.publish_status(now)
        r.delete(f"cam:{w.id}:status")  # what a Redis restart does
        p.publish_status(now)
        assert r.exists(f"cam:{w.id}:status") == 1
    finally:
        r.delete(f"cam:{w.id}:status")


def test_frame_is_a_jpeg_with_a_10_s_ttl(r):
    now = time.time()
    w = fake_worker(now, frame=np.zeros((1080, 2560, 3), np.uint8))
    p = publisher(r, [w], now)
    try:
        p.publish_frames(now)
        jpeg = r.get(f"cam:{w.id}:frame")
        assert jpeg.startswith(b"\xff\xd8")
        assert 0 < r.pttl(f"cam:{w.id}:frame") <= 10_000
        assert cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR).shape[:2] == (540, 1280)
        # only a newer frame is published again
        r.delete(f"cam:{w.id}:frame")
        p.publish_frames(now)
        assert r.exists(f"cam:{w.id}:frame") == 0
        w.last_frame_at += 1
        p.publish_frames(now)
        assert r.exists(f"cam:{w.id}:frame") == 1
    finally:
        r.delete(f"cam:{w.id}:frame")


def test_forget_deletes_the_status(r):
    now = time.time()
    w = fake_worker(now)
    p = publisher(r, [w], now)
    p.publish_status(now)
    p.forget(w.id)
    assert r.exists(f"cam:{w.id}:status") == 0


def test_the_thread_publishes_and_stops(r):
    now = time.time()
    w = fake_worker(now, frame=np.zeros((90, 160, 3), np.uint8))
    p = publisher(r, [w], now)
    p.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (r.exists(f"cam:{w.id}:status") and r.exists(f"cam:{w.id}:frame")):
            time.sleep(0.05)  # bounded poll for the thread's first round
        assert r.exists(f"cam:{w.id}:status") and r.exists(f"cam:{w.id}:frame")
    finally:
        p.stop()
        p.join(5)
        r.delete(f"cam:{w.id}:status", f"cam:{w.id}:frame")
    assert not p.is_alive()
