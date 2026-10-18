"""Encodes and publishes annotated debug JPEG frames when a viewer is watching."""

import logging
import threading
import time
from typing import Any, Callable

import cv2
import redis

from core.base_pipeline import BasePipeline

logger = logging.getLogger("DebugPublisher")

# Capped by the camera's own processing rate; ~3 ms and ~110 KB per 960 px JPEG on the dev laptop, so 15 fps costs
# ~4% of a core and ~14 Mbit/s per viewer (a troubleshooting view, not the everyday one)
DEBUG_MAX_FPS = 15


class DebugPublisher(threading.Thread):
    """Background thread that publishes debug MJPEG frames for cameras with active viewers.

    Once a second, checks if `cam:{id}:debug` exists in Redis for each camera.
    For any camera where the key exists, encodes `latest_frame()` at up to DEBUG_MAX_FPS (15) per second
    scaled to at most 960 px wide at JPEG quality 70, and publishes the bytes to
    `cam:{id}:debugframes`. If the key does not exist, no frames are encoded.
    """

    def __init__(
        self,
        redis_client: Any,
        pipelines: Callable[[], dict[str, BasePipeline]],
        clock: Callable[[], float] = time.monotonic,
    ):
        super().__init__(name="debug-publisher", daemon=True)
        self.redis = redis_client
        self.pipelines = pipelines
        self.clock = clock
        self._stop_event = threading.Event()
        self._watched_cameras: set[str] = set()
        self._last_check_time = -1.0
        self._last_encoded_frame_at: dict[str, float] = {}
        self._last_publish_time: dict[str, float] = {}
        self._last_error_log = 0.0

    def stop(self, timeout: float = 2.0) -> None:
        """Stops the thread and waits for it to exit."""
        self._stop_event.set()
        if self.is_alive():
            self.join(timeout)

    def run(self) -> None:
        while not self._stop_event.is_set():
            now = self.clock()

            # 1. Once a second, pipeline EXISTS cam:{id}:debug for every camera
            if now - self._last_check_time >= 1.0:
                self._last_check_time = now
                try:
                    current_pipelines = self.pipelines()
                    if current_pipelines:
                        pipe = self.redis.pipeline()
                        cam_ids = list(current_pipelines.keys())
                        for cid in cam_ids:
                            pipe.exists(f"cam:{cid}:debug")
                        results = pipe.execute()
                        self._watched_cameras = {cid for cid, res in zip(cam_ids, results) if res}
                    else:
                        self._watched_cameras = set()
                except Exception as e:
                    now_mono = time.monotonic()
                    if now_mono - self._last_error_log >= 60.0:
                        self._last_error_log = now_mono
                        logger.warning("DebugPublisher key check failed: %s", e)

            # 2. For each watched camera, publish latest_frame() at most DEBUG_MAX_FPS per second, when last_frame_at changed
            if self._watched_cameras:
                try:
                    current_pipelines = self.pipelines()
                except Exception:
                    current_pipelines = {}

                for cid in list(self._watched_cameras):
                    pipe_obj = current_pipelines.get(cid)
                    if pipe_obj is None:
                        continue

                    if now - self._last_publish_time.get(cid, 0.0) < 1.0 / DEBUG_MAX_FPS:
                        continue

                    last_frame_at = getattr(pipe_obj, "last_frame_at", 0.0)
                    if last_frame_at == self._last_encoded_frame_at.get(cid) or last_frame_at == 0.0:
                        continue

                    frame = pipe_obj.latest_frame()
                    if frame is None:
                        continue

                    try:
                        h, w = frame.shape[:2]
                        if w > 960:
                            scale = 960.0 / w
                            target_w = 960
                            target_h = max(1, int(round(h * scale)))
                            encoded_frame = cv2.resize(
                                frame, (target_w, target_h), interpolation=cv2.INTER_AREA
                            )
                        else:
                            encoded_frame = frame

                        success, buf = cv2.imencode(
                            ".jpg", encoded_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70]
                        )
                        if success:
                            jpeg_bytes = buf.tobytes()
                            self.redis.publish(f"cam:{cid}:debugframes", jpeg_bytes)
                            self._last_encoded_frame_at[cid] = last_frame_at
                            self._last_publish_time[cid] = now
                    except Exception as e:
                        now_mono = time.monotonic()
                        if now_mono - self._last_error_log >= 60.0:
                            self._last_error_log = now_mono
                            logger.warning("DebugPublisher frame publish failed for %s: %s", cid, e)

            self._stop_event.wait(0.02)
