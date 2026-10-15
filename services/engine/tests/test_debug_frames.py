import cv2
import numpy as np
import pytest

from core.debug_frames import DebugPublisher


class FakePipeline:
    def __init__(self, frame, last_frame_at=1.0):
        self._frame = frame
        self.last_frame_at = last_frame_at

    def latest_frame(self):
        return self._frame


class FakePipelineExecutor:
    def __init__(self, keys):
        self.keys = keys
        self.commands = []

    def exists(self, key):
        self.commands.append(("exists", key))

    def execute(self):
        results = [1 if k in self.keys else 0 for op, k in self.commands]
        self.commands.clear()
        return results


class FakeRedisForDebug:
    def __init__(self):
        self.keys = set()
        self.published = []

    def pipeline(self):
        return FakePipelineExecutor(self.keys)

    def publish(self, channel: str, message: bytes):
        self.published.append((channel, message))
        return 1


class ControlledClock:
    def __init__(self, start=0.0):
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


def test_debug_publisher_encodes_only_while_the_key_exists():
    fake_redis = FakeRedisForDebug()
    clock = ControlledClock(0.0)

    # 1080 x 1920 frame
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    pipeline = FakePipeline(frame, last_frame_at=1.0)
    pipelines_map = {"cam_gate": pipeline}

    publisher = DebugPublisher(
        redis_client=fake_redis,
        pipelines=lambda: pipelines_map,
        clock=clock,
    )

    # 1. No key: run one check iteration (simulate thread body without starting background thread)
    clock.advance(1.5)  # triggers key check
    publisher.run_once = lambda: None  # we can step manually or run thread
    # Let's start the publisher thread
    publisher.start()

    # Wait a bit with no key: 0 published
    import time
    time.sleep(0.05)
    assert len(fake_redis.published) == 0

    # 2. Key is SET: cam_gate:debug
    fake_redis.keys.add("cam:cam_gate:debug")
    clock.advance(1.5)  # triggers key check in publisher loop

    # Wait for frame to be published
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and len(fake_redis.published) == 0:
        time.sleep(0.02)

    assert len(fake_redis.published) >= 1
    channel, jpeg_bytes = fake_redis.published[0]
    assert channel == "cam:cam_gate:debugframes"
    assert jpeg_bytes.startswith(b"\xff\xd8")  # JPEG header

    # Verify resized width <= 960
    decoded = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None
    h, w = decoded.shape[:2]
    assert w <= 960
    assert w == 960
    assert h == 540

    # 3. Key is deleted: key gone -> stops publishing
    fake_redis.keys.remove("cam:cam_gate:debug")
    clock.advance(1.5)  # triggers next key check
    time.sleep(0.05)
    count_after_key_removed = len(fake_redis.published)

    # Update frame time so it would have published if key still existed
    pipeline.last_frame_at += 1.0
    clock.advance(0.5)
    time.sleep(0.05)

    assert len(fake_redis.published) == count_after_key_removed

    publisher.stop()
