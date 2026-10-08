"""
Zoo Vision Analytics Dispatcher
Dispatches structured telemetry and alert events from CV pipelines to the
Web Analytics Dashboard API (zoo-analytics-web, POST /api/events) asynchronously.
Non-blocking background thread prevents any latency impact on video processing.
"""

import json
import time
import uuid
import queue
import logging
import threading
from typing import Dict, Any, Optional
import requests

logger = logging.getLogger("AnalyticsDispatcher")

MAX_RETRY_BUFFER = 5000


def new_event_id() -> str:
    return f"evt_{uuid.uuid4().hex[:12]}"


def _jsonable(o):
    """json.dumps fallback: numpy scalars (np.int64 tracker ids, np.float32 confidences, np.bool_) -> Python."""
    return o.item() if hasattr(o, "item") else str(o)


class AnalyticsDispatcher:
    def __init__(
        self,
        api_url: str = "http://localhost:3000/api/events",
        api_key: Optional[str] = None,
        enabled: bool = True,
        batch_size: int = 20,
        flush_interval_sec: float = 2.0,
        mock_mode: bool = False
    ):
        self.api_url = api_url
        self.api_key = api_key
        self.enabled = enabled
        self.batch_size = batch_size
        self.flush_interval_sec = flush_interval_sec
        self.mock_mode = mock_mode

        self._queue = queue.Queue(maxsize=1000)
        self._running = False
        self._failing = False
        self._worker_thread: Optional[threading.Thread] = None
        self._session = requests.Session()

        if self.api_key:
            self._session.headers.update({"Authorization": f"Bearer {self.api_key}"})

        if self.enabled:
            self.start()

    def start(self):
        """Starts background worker thread for asynchronous event flushing."""
        if self._running:
            return
        self._running = True
        self._worker_thread = threading.Thread(target=self._worker_loop, daemon=True, name="AnalyticsDispatcherWorker")
        self._worker_thread.start()
        logger.info(f"AnalyticsDispatcher started -> Target: {self.api_url} (Mock: {self.mock_mode})")

    def stop(self):
        """Gracefully stops background worker, flushing what is still queued."""
        self._running = False
        if self._worker_thread:
            self._worker_thread.join(timeout=7.0)  # up to 2 s queue wait + 4 s POST timeout

    def dispatch(
        self,
        use_case: str,
        event_type: str,
        camera_id: str,
        camera_name: str,
        data: Dict[str, Any],
        severity: str = "info",
        nx_camera_id: Optional[str] = None,
        timestamp_ms: Optional[int] = None,
        event_id: Optional[str] = None
    ):
        """
        Enqueues an event for asynchronous delivery.
        Non-blocking: will drop with a warning if queue is completely full.
        """
        if not self.enabled:
            return

        ts = timestamp_ms or int(time.time() * 1000)
        payload = {
            "eventId": event_id or new_event_id(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts / 1000.0)),
            "timestampMs": ts,
            "cameraId": camera_id,
            "cameraName": camera_name,
            "useCase": use_case,
            "eventType": event_type,
            "severity": severity,
            "nxCameraId": nx_camera_id,
            "data": data
        }

        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            logger.warning("[AnalyticsDispatcher] Event queue full. Dropped event.")

    def _worker_loop(self):
        """Background worker that flushes queued events in batches, retrying while the API is down."""
        batch = []
        last_flush = time.time()

        while self._running:
            try:
                # Wait for items with timeout
                timeout = max(0.1, self.flush_interval_sec - (time.time() - last_flush))
                batch.append(self._queue.get(timeout=timeout))
                self._queue.task_done()
            except queue.Empty:
                pass

            full = len(batch) >= self.batch_size and not self._failing  # while failing, retry on the timer only
            if batch and (full or time.time() - last_flush >= self.flush_interval_sec):
                if self._flush_batch(batch):
                    batch = []
                else:
                    # ponytail: in-memory retry buffer, lost on exit; the dashboard dedups by eventId
                    batch = batch[-MAX_RETRY_BUFFER:]
                last_flush = time.time()

        # Final drain on exit
        while not self._queue.empty():
            batch.append(self._queue.get_nowait())
        if batch:
            self._flush_batch(batch)

    def _flush_batch(self, batch: list) -> bool:
        """Sends a batch of events to the web analytics API. Returns False when it should be retried."""
        if not batch:
            return True

        if self.mock_mode:
            logger.debug(f"[MOCK ANALYTICS FLUSH] Sent {len(batch)} event(s) to {self.api_url}")
            return True

        try:
            resp = self._session.post(
                self.api_url,
                data=json.dumps({"events": batch}, default=_jsonable),
                headers={"Content-Type": "application/json"},
                timeout=4.0,
            )
        except Exception as e:  # never let anything kill the worker thread
            return self._failed(f"{type(e).__name__}: {e}")

        if resp.status_code >= 500:
            return self._failed(f"HTTP {resp.status_code}")
        if resp.status_code not in (200, 201):
            # 4xx (bad API key, malformed request) will not get better by retrying
            logger.warning(f"Analytics API rejected {len(batch)} event(s) with HTTP {resp.status_code}: {resp.text[:120]}")
        elif self._failing:
            logger.info(f"Analytics API reachable again, delivered {len(batch)} buffered event(s).")
        self._failing = False
        return True

    def _failed(self, reason: str) -> bool:
        if not self._failing:
            logger.warning(f"Analytics API unreachable at {self.api_url} ({reason}). Buffering events and retrying.")
        self._failing = True
        return False


if __name__ == "__main__":
    # Self-check: python -m core.analytics_dispatcher
    import numpy as np

    sample = {"trackerId": np.int64(7), "ocrConfidence": np.float32(0.5), "plateValid": np.bool_(True)}
    assert json.loads(json.dumps(sample, default=_jsonable)) == {"trackerId": 7, "ocrConfidence": 0.5, "plateValid": True}

    unreachable = AnalyticsDispatcher(api_url="http://127.0.0.1:9/api/events", enabled=False)
    assert unreachable._flush_batch([{"trackerId": np.int64(1)}]) is False
    print("ok")
