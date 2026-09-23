"""
Threaded Stream Manager with FPS Throttling and Auto-Reconnect.
Ingests video from RTSP (Nx Server), webcams, or local MP4 files without frame buffer lag.
"""

import time
import threading
import logging
import cv2
import numpy as np
from typing import Optional, Tuple

logger = logging.getLogger("StreamManager")


class StreamManager:
    def __init__(self, source: str, camera_id: str, target_fps: int = 10):
        self.source = source
        self.camera_id = camera_id
        self.target_fps = target_fps
        self.frame_interval = 1.0 / target_fps if target_fps > 0 else 0.1

        # Check if source is integer (local camera index)
        if self.source.isdigit():
            self.source = int(self.source)

        self.cap: Optional[cv2.VideoCapture] = None
        self.latest_frame: Optional[np.ndarray] = None
        self.latest_timestamp_ms: int = 0
        self.is_running = False
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None

    def start(self):
        """Starts the background frame reader thread."""
        self.is_running = True
        self._connect()
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()
        logger.info(f"[{self.camera_id}] Stream reader started @ target {self.target_fps} FPS (Source: {self.source})")

    def _connect(self):
        """Attempts connection to the video source."""
        if self.cap is not None:
            self.cap.release()

        logger.info(f"[{self.camera_id}] Connecting to stream source...")
        self.cap = cv2.VideoCapture(self.source)
        if not self.cap.isOpened():
            logger.warning(f"[{self.camera_id}] Failed to open stream source: {self.source}")

    def _capture_loop(self):
        """Continuously pulls frames, dropping old ones to prevent RTSP buffer lag."""
        reconnect_delay = 2.0
        last_yield_time = 0.0

        while self.is_running:
            if self.cap is None or not self.cap.isOpened():
                time.sleep(reconnect_delay)
                self._connect()
                continue

            ret, frame = self.cap.read()
            if not ret:
                # If reading a file, loop back to the start
                if isinstance(self.source, str) and not self.source.startswith("rtsp://"):
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    time.sleep(0.05)
                    continue

                logger.warning(f"[{self.camera_id}] RTSP stream read failed. Reconnecting in {reconnect_delay}s...")
                time.sleep(reconnect_delay)
                self._connect()
                continue

            current_time = time.time()
            # Throttle to target FPS
            if current_time - last_yield_time >= self.frame_interval:
                with self.lock:
                    self.latest_frame = frame
                    self.latest_timestamp_ms = int(current_time * 1000)
                last_yield_time = current_time

            # Small sleep to yield CPU
            time.sleep(0.005)

    def get_frame(self) -> Tuple[Optional[np.ndarray], int]:
        """Returns the latest available frame and timestamp."""
        with self.lock:
            return self.latest_frame, self.latest_timestamp_ms

    def stop(self):
        """Stops the reader thread and releases hardware resources."""
        self.is_running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.0)
        if self.cap:
            self.cap.release()
        logger.info(f"[{self.camera_id}] Stream reader stopped.")
