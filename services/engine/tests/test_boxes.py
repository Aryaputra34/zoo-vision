import time
import numpy as np
import pytest
import supervision as sv

from conftest import make_pipeline
from contracts.boxes import Boxes
from core.boxes import BoxPublisher


class FakeBoxStore:
    def __init__(self):
        self.offered = []

    def offer(self, camera_id: str, payload: dict) -> None:
        self.offered.append((camera_id, payload))


class FakeRedisClient:
    def __init__(self):
        self.published = []

    def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1


def test_publish_boxes_normalises_and_matches_the_contract():
    p = make_pipeline("vehicle_gate")
    store = FakeBoxStore()
    p.boxes = store
    p._current_frame_size = (1080, 1920)
    p._current_timestamp_ms = 1760436000123

    # Box: x1=192, y1=108, x2=960, y2=540 (in 1920x1080 -> 0.1, 0.1, 0.5, 0.5)
    xyxy = np.array([[192.0, 108.0, 960.0, 540.0]])
    detections = sv.Detections(
        xyxy=xyxy,
        confidence=np.array([0.95]),
        class_id=np.array([2]),
        tracker_id=np.array([42]),
    )

    p.publish_boxes(detections)

    assert len(store.offered) == 1
    camera_id, payload = store.offered[0]
    assert camera_id == p.camera_id

    # Validate against Pydantic contract model
    validated = Boxes.model_validate(payload)
    assert validated.cameraId == p.camera_id
    assert validated.t == 1760436000123
    assert len(validated.boxes) == 1

    b = validated.boxes[0]
    assert b.trackId == 42
    assert b.cls == 2
    assert b.x1 == pytest.approx(0.1, abs=1e-4)
    assert b.y1 == pytest.approx(0.1, abs=1e-4)
    assert b.x2 == pytest.approx(0.5, abs=1e-4)
    assert b.y2 == pytest.approx(0.5, abs=1e-4)


def test_untracked_detections_get_track_id_none():
    p = make_pipeline("cashier_presence")
    store = FakeBoxStore()
    p.boxes = store
    p._current_frame_size = (720, 1280)
    p._current_timestamp_ms = 1760436000456

    xyxy = np.array([[128.0, 72.0, 640.0, 360.0]])
    detections = sv.Detections(
        xyxy=xyxy,
        confidence=np.array([0.8]),
        class_id=np.array([0]),
        tracker_id=None,
    )

    p.publish_boxes(detections)

    assert len(store.offered) == 1
    _, payload = store.offered[0]
    validated = Boxes.model_validate(payload)
    assert validated.boxes[0].trackId is None
    assert validated.boxes[0].cls == 0


def test_box_publisher_keeps_only_the_latest_per_camera():
    fake_redis = FakeRedisClient()
    pub = BoxPublisher(redis_client=fake_redis)

    # Offer 3 times while thread is not running
    pub._pending.clear()
    pub.offer("cam1", {"cameraId": "cam1", "t": 1, "boxes": []})
    pub.offer("cam1", {"cameraId": "cam1", "t": 2, "boxes": []})
    pub.offer("cam1", {"cameraId": "cam1", "t": 3, "boxes": []})

    # Only latest should remain in _pending
    assert len(pub._pending) == 1
    assert pub._pending["cam1"]["t"] == 3

    # Now start and let it publish
    pub.start()
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and len(fake_redis.published) < 1:
        time.sleep(0.01)

    pub.stop()

    assert len(fake_redis.published) == 1
    channel, msg = fake_redis.published[0]
    assert channel == "cam:cam1:boxes"
    assert '"t":3' in msg
