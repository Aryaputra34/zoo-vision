"""
Threaded Stream Manager with FPS Throttling and Auto-Reconnect.
Ingests video from RTSP (Nx Server), webcams, or local MP4 files without frame buffer lag.
A file plays in real time at its own frame rate, like a camera, and loops at its end.
"""

import math
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
FILE_FPS_DEFAULT = 25.0  # a file whose frame rate is missing or unusable plays at this rate
FILE_FPS_MAX = 1000.0

_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
# the scheme of a URL to mask, after any leading whitespace
_MASK_SCHEME = re.compile(r"^(\s*[A-Za-z][A-Za-z0-9+.-]*://)")
_SECRET_WORDS = r"(?:pass|pwd|pw|token|key|auth|secret|sig|cred|session)"
# a query parameter whose name holds a secret word (access_token, api_key, apikey, X-Amz-Signature, jsessionid, ...);
# its value runs to the next '&', so a '#' or ';' inside it is masked too
_SECRET_PARAM = re.compile(rf"(?i)([?&;][^=&#;]*{_SECRET_WORDS}[^=&#;]*=)[^&]*")
# XMEye / Sofia paths carry credentials as parameters of the path itself: /user=admin_password=Secr3t_channel=1.sdp;
# everything after a secret-named `=` goes, because the value's end can not be told
_SECRET_PATH = re.compile(rf"(?i)([/_][^=/_?&#;]*{_SECRET_WORDS}[^=/_?&#;]*=).*")


def mask_url(url: str) -> str:
    """Hide credentials in a stream URL. Fails closed: over-masking is fine, leaking is not.

    Everything between `scheme://` and the last `@` anywhere after it becomes `***` (a password may hold `#`, `?`
    or `@`, and a query value may be a URL with credentials); the values of query parameters whose name holds a
    secret word become `***` up to the next `&`; a secret-named parameter inside the path (`/user=a_password=b_...`)
    hides the rest of the path. Leading whitespace is kept. Other strings are returned unchanged.
    """
    url = str(url)
    scheme = _MASK_SCHEME.match(url)
    if not scheme:
        return url
    prefix, rest = url[: scheme.end()], url[scheme.end():]
    at = rest.rfind("@")
    if at >= 0:
        rest = "***" + rest[at:]
    path, question, query = rest.partition("?")
    in_path = _SECRET_PATH.search(path)
    if in_path:
        # where the credential ends can not be told (it may hold a '?'): the rest of the URL goes with it
        return prefix + path[: in_path.end(1)] + "***"
    return prefix + _SECRET_PARAM.sub(r"\g<1>***", path + question + query)


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
        self._clock = time.monotonic  # paces the reads and the hand-outs (tests put a virtual clock here)
        self._file_period = 1.0 / FILE_FPS_DEFAULT  # a file: seconds between two of its frames
        self._next_due: Optional[float] = None  # a file: when its next frame is due, on _clock

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
        elif not self.live:
            self._file_period = 1.0 / self._file_fps()
            self._next_due = None

    def _file_fps(self) -> float:
        try:
            fps = float(self.cap.get(cv2.CAP_PROP_FPS))
        except Exception:
            fps = 0.0
        if not (math.isfinite(fps) and 0 < fps <= FILE_FPS_MAX):
            logger.info(f"[{self.camera_id}] The file reports no usable frame rate: playing it at {FILE_FPS_DEFAULT:.0f} fps")
            return FILE_FPS_DEFAULT
        return fps

    def _pace_file(self) -> bool:
        """A file plays in real time: waits until its next frame is due. A reader that fell behind (a slow decode)
        skips the frames it missed (grab, no decode) instead of drifting behind the clock. True once stopping."""
        period, now = self._file_period, self._clock()
        if self._next_due is None:
            self._next_due = now
        elif now < self._next_due:
            if self._wait(self._next_due - now):
                return True
        else:
            missed = int((now - self._next_due) / period)
            for _ in range(missed):
                if not self.cap.grab():
                    break  # the end: the read below fails and the file loops back
            self._next_due += missed * period
        self._next_due += period
        return False

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
        last_yield_time = -math.inf

        while not self._stop_event.is_set():
            if self.cap is None or not self.cap.isOpened():
                if self._wait(reconnect_delay):
                    return
                reconnect_delay = min(reconnect_delay * 2, RECONNECT_MAX_S)
                self._connect()
                continue

            if not self.live and self._pace_file():
                return
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
            now = self._clock()
            # Throttle to target FPS
            if now - last_yield_time >= self.frame_interval:
                with self.lock:
                    self.latest_frame = frame
                    self.latest_timestamp_ms = int(time.time() * 1000)
                last_yield_time = now

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
