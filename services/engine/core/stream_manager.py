"""
Threaded Stream Manager with FPS Throttling and Auto-Reconnect.
Ingests video from RTSP (Nx Server), webcams, or local MP4 files without frame buffer lag.
"""

import os
import re
import time
import threading
import logging

# RTSP over TCP: OpenCV's FFmpeg backend defaults to UDP, which loses packets under load and smears
# frames. Must be set before cv2 opens a stream; an explicit environment value wins.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

import cv2
import numpy as np
from typing import Optional, Tuple

logger = logging.getLogger("StreamManager")

RECONNECT_MIN_S = 2.0
RECONNECT_MAX_S = 30.0

_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
# a parameter whose name holds a secret word (access_token, api_key, apikey, X-Amz-Signature, jsessionid, ...)
_SECRET_PARAM = re.compile(
    r"(?i)([?&;][^=&#;]*(?:pass|pwd|token|key|auth|secret|sig|cred|session)[^=&#;]*=)[^&#;]*"
)


def mask_url(url: str) -> str:
    """Hide credentials in a stream URL. Fails closed: over-masking is fine, leaking is not.

    Everything between `scheme://` and the last `@` anywhere after it becomes `***` (a password may hold `#`, `?`
    or `@`, and a query value may be a URL with credentials), and the values of query parameters whose name holds
    a secret word become `***`. Other strings are returned unchanged.
    """
    url = str(url)
    scheme = _SCHEME.match(url)
    if not scheme:
        return url
    prefix, rest = url[: scheme.end()], url[scheme.end():]
    at = rest.rfind("@")
    if at >= 0:
        rest = "***" + rest[at:]
    return _SECRET_PARAM.sub(r"\g<1>***", prefix + rest)


def is_live_source(source) -> bool:
    """A camera index, or a URL with any scheme but file:// (rtsp, rtsps, http, any case), is live: a failed read
    reconnects. Anything else is a file, which loops back to its start."""
    if isinstance(source, int):
        return True
    scheme = _SCHEME.match(source)
    return scheme is not None and scheme.group(0)[:-3].lower() != "file"


class StreamManager:
    """Reads one source in its own thread and keeps only the latest frame. stop() wakes the reader at once, even in
    its reconnect backoff; once stop() was called it never connects again."""

    def __init__(self, source: str, camera_id: str, target_fps: int = 10):
        self.source = source
        self.camera_id = camera_id
        self.target_fps = target_fps
        self.frame_interval = 1.0 / target_fps if target_fps > 0 else 0.1

        # Check if source is integer (local camera index)
        if self.source.isdigit():
            self.source = int(self.source)
        self.live = is_live_source(self.source)

        self.cap: Optional[cv2.VideoCapture] = None
        self.latest_frame: Optional[np.ndarray] = None
        self.latest_timestamp_ms: int = 0
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def start(self):
        """Opens the source, then starts the background frame reader thread."""
        self._connect()
        self.thread = threading.Thread(target=self._capture_loop, name=f"stream-{self.camera_id}", daemon=True)
        self.thread.start()
        logger.info(f"[{self.camera_id}] Stream reader started @ target {self.target_fps} FPS (Source: {mask_url(self.source)})")

    def _connect(self):
        """(Re)opens the source; does nothing once stop() was called."""
        self._release()
        if self._stop_event.is_set():
            return
        logger.info(f"[{self.camera_id}] Connecting to stream source...")
        self.cap = cv2.VideoCapture(self.source)
        if not self.cap.isOpened():
            logger.warning(f"[{self.camera_id}] Failed to open stream source: {mask_url(self.source)}")

    def _release(self):
        cap, self.cap = self.cap, None
        if cap is not None:
            cap.release()

    def _wait(self, seconds: float) -> bool:
        """Waits `seconds`, or less when stop() is called meanwhile. True once stopping."""
        return self._stop_event.wait(seconds)

    def _capture_loop(self):
        """Continuously pulls frames, dropping old ones to prevent RTSP buffer lag. Releases the source on exit."""
        try:
            self._read_frames()
        finally:
            self._release()

    def _read_frames(self):
        reconnect_delay = RECONNECT_MIN_S
        last_yield_time = 0.0

        while not self._stop_event.is_set():
            if self.cap is None or not self.cap.isOpened():
                if self._wait(reconnect_delay):
                    return
                reconnect_delay = min(reconnect_delay * 2, RECONNECT_MAX_S)
                self._connect()
                continue

            ret, frame = self.cap.read()
            if not ret:
                # If reading a file, loop back to the start
                if not self.live:
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    if self._wait(0.05):
                        return
                    continue

                logger.warning(f"[{self.camera_id}] Stream read failed. Reconnecting in {reconnect_delay}s...")
                if self._wait(reconnect_delay):
                    return
                reconnect_delay = min(reconnect_delay * 2, RECONNECT_MAX_S)
                self._connect()
                continue

            reconnect_delay = RECONNECT_MIN_S
            current_time = time.time()
            # Throttle to target FPS
            if current_time - last_yield_time >= self.frame_interval:
                with self.lock:
                    self.latest_frame = frame
                    self.latest_timestamp_ms = int(current_time * 1000)
                last_yield_time = current_time

            # Small sleep to yield CPU
            if self._wait(0.005):
                return

    def get_frame(self) -> Tuple[Optional[np.ndarray], int]:
        """Returns the latest available frame and timestamp."""
        with self.lock:
            return self.latest_frame, self.latest_timestamp_ms

    def stop(self):
        """Stops the reader thread and releases the source. Waits up to 1 s: the reader is only slow to stop while
        it is inside an open or a read, and then releases the source itself when that call returns."""
        self._stop_event.set()
        thread = self.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        if thread is None or not thread.is_alive():
            self._release()
            logger.info(f"[{self.camera_id}] Stream reader stopped.")
        else:
            logger.warning(f"[{self.camera_id}] Stream reader is in a blocking call; it stops when the call returns.")
