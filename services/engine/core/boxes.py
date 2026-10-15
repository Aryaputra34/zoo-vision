"""Publishes bounding boxes per camera to Redis without blocking camera threads."""

import json
import logging
import threading
import time
from typing import Any

import redis

logger = logging.getLogger("BoxPublisher")


class BoxPublisher(threading.Thread):
    """Worker thread that publishes the latest bounding boxes for each camera to Redis pub/sub.

    offer() is non-blocking and overwrites any pending un-sent payload for that camera,
    ensuring camera worker threads never wait on Redis and slow consumers don't accumulate backlog.
    """

    def __init__(self, redis_client: Any = None, redis_url: str | None = None):
        super().__init__(name="box-publisher", daemon=True)
        if redis_client is None:
            if not redis_url:
                raise ValueError("BoxPublisher needs a redis_client or redis_url")
            redis_client = redis.Redis.from_url(
                redis_url, socket_timeout=2, socket_connect_timeout=2
            )
        self.redis = redis_client
        self._pending: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._running = True
        self._last_error_log = 0.0

    def offer(self, camera_id: str, payload: dict) -> None:
        """Keeps only the latest box set per camera, never blocks."""
        with self._lock:
            self._pending[camera_id] = payload
            self._cond.notify()

    def stop(self, timeout: float = 2.0) -> None:
        """Stops the publisher thread and waits for it to exit."""
        with self._lock:
            self._running = False
            self._cond.notify_all()
        if self.is_alive():
            self.join(timeout)

    def run(self) -> None:
        while self._running:
            with self._lock:
                while self._running and not self._pending:
                    self._cond.wait(timeout=0.1)
                if not self._running:
                    break
                items = list(self._pending.items())
                self._pending.clear()

            for camera_id, payload in items:
                try:
                    channel = f"cam:{camera_id}:boxes"
                    raw = json.dumps(payload, separators=(",", ":"), allow_nan=False)
                    self.redis.publish(channel, raw)
                except Exception as e:
                    now = time.monotonic()
                    if now - self._last_error_log >= 60.0:
                        self._last_error_log = now
                        logger.warning("Failed to publish boxes to Redis: %s", e)
