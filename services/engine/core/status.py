"""Publishes what the cameras are doing to Redis, for the API: `cam:{id}:status` every 5 s and `cam:{id}:frame`
every 2 s (a status also goes out at once when a worker's state, applied version or config error changes).

A status key expires 15 s after the camera's last processed frame (or its worker's start, before the first one),
whatever the engine does, so a dead stream turns into an offline interval. The publisher only reads the workers'
attributes; Redis errors are logged and the next round tries again, so the keys come back after a Redis restart.
"""

import json
import logging
import threading
import time
from typing import Callable, Iterable

import cv2
import redis

logger = logging.getLogger("StatusPublisher")

STATUS_EVERY_S = 5.0
FRAME_EVERY_S = 2.0
STATUS_TTL_S = 15.0
RECONNECTING_AFTER_S = 5.0
FRAME_TTL_MS = 10_000
FRAME_MAX_WIDTH = 1280
FRAME_QUALITY = 80
TICK_S = 0.25


def _text(value) -> str:
    return "" if value is None else str(value)


class StatusPublisher(threading.Thread):
    def __init__(self, redis_client, workers: Callable[[], Iterable], *, engine_group: str, boot_id: str,
                 clock: Callable[[], float] = time.time):
        super().__init__(name="status-publisher", daemon=True)
        self._r, self._workers, self._group, self._boot_id, self._clock = (
            redis_client, workers, engine_group, boot_id, clock)
        self._stop_event = threading.Event()
        self._frame_marks: dict[str, float] = {}  # camera id -> last_frame_at of the frame published last
        self._published: dict[str, tuple] = {}  # camera id -> (state, applied version, config error) last published
        self._failing = False

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        next_status = next_frames = time.monotonic()
        while not self._stop_event.is_set():
            now = time.monotonic()
            if now >= next_status or self._changed():
                self._guard(self.publish_status)
                next_status = now + STATUS_EVERY_S
            if now >= next_frames:
                self._guard(self.publish_frames)
                next_frames = now + FRAME_EVERY_S
            self._stop_event.wait(TICK_S)

    def _changed(self) -> bool:
        """A worker's state, applied version or config error differs from what was published: the API should not
        wait for the next heartbeat to see a config applied or rejected."""
        try:
            return any(w.state != "stopped" and self._published.get(w.id) != _signature(w)
                       for w in self._workers())
        except Exception:
            return False

    def _guard(self, publish: Callable[[float], None]) -> None:
        try:
            publish(self._clock())
            if self._failing:
                self._failing = False
                logger.info("Publishing to Redis works again")
        except redis.RedisError as e:
            if not self._failing:
                self._failing = True
                logger.warning("Cannot publish to Redis (%s); retrying every round", type(e).__name__)
        except Exception:
            logger.exception("Publishing failed")

    def publish_status(self, now: float) -> None:
        for w in list(self._workers()):
            if w.state == "stopped":  # the supervisor deletes its key
                continue
            last_frame_at = w.last_frame_at
            anchor = w.started_at if last_frame_at is None else max(last_frame_at, w.started_at)
            expire_at = anchor + STATUS_TTL_S
            if expire_at <= now:
                self._published[w.id] = _signature(w)  # nothing to write; don't retry before something changes
                continue
            state = w.state
            if state == "running" and last_frame_at is not None and now - last_frame_at > RECONNECTING_AFTER_S:
                state = "reconnecting"
            pipeline = w.pipeline
            key = f"cam:{w.id}:status"
            fields = {
                "state": state,
                "fps": f"{w.fps:.1f}",
                "lastFrameAt": "" if last_frame_at is None else str(int(last_frame_at * 1000)),
                "appliedVersion": _text(w.applied_version),
                "configError": _text(w.config_error),
                "useCase": w.config.use_case,
                "engineGroup": self._group,
                "bootId": self._boot_id,
                "restarts": str(w.restarts),
                "live": json.dumps(pipeline.live if pipeline is not None else {}),
                "updatedAt": str(int(now * 1000)),
            }
            pipe = self._r.pipeline(transaction=False)
            pipe.hset(key, mapping=fields)
            pipe.pexpireat(key, int(expire_at * 1000))
            pipe.execute()
            self._published[w.id] = _signature(w)

    def publish_frames(self, now: float) -> None:
        workers = list(self._workers())
        self._frame_marks = {w.id: self._frame_marks[w.id] for w in workers if w.id in self._frame_marks}
        for w in workers:
            mark, frame = w.last_frame_at, w.latest_raw
            if frame is None or mark is None or self._frame_marks.get(w.id) == mark:
                continue
            jpeg = _encode(frame)
            if jpeg is None:
                continue
            self._r.set(f"cam:{w.id}:frame", jpeg, px=FRAME_TTL_MS)
            self._frame_marks[w.id] = mark

    def forget(self, camera_id: str) -> None:
        self._frame_marks.pop(camera_id, None)
        self._published.pop(camera_id, None)
        try:
            self._r.delete(f"cam:{camera_id}:status")
        except redis.RedisError as e:
            logger.warning("[%s] Could not delete the status (%s); it expires by itself", camera_id, type(e).__name__)


def _signature(w) -> tuple:
    return w.state, w.applied_version, w.config_error


def _encode(frame) -> bytes | None:
    h, w = frame.shape[:2]
    if w > FRAME_MAX_WIDTH:
        frame = cv2.resize(frame, (FRAME_MAX_WIDTH, max(1, round(h * FRAME_MAX_WIDTH / w))),
                           interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, FRAME_QUALITY])
    return buf.tobytes() if ok else None
