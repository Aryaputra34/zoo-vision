"""
Abstract Base Pipeline for all Zoo Computer Vision attraction monitors.
Standardizes YOLO model loading, frame processing, and Nx Event dispatching.
main.py / test_video.py call run(), which wraps process_frame() with event snapshots and the live preview.
"""

from abc import ABC, abstractmethod
import logging
import threading
import time
from typing import Dict, Any, Optional
import numpy as np
import yaml
from ultralytics import YOLO

from core.event_stream import EventStream
from core.messages import event_message, interval_close_message, interval_open_message, metric_message, new_id
from core.metrics import MinuteMetrics
from core.model_store import resolve_model_path
from nx_integration.nx_client import NxClient

logger = logging.getLogger("BasePipeline")


class BasePipeline(ABC):
    use_case = ""       # contract use case id, set by each subclass
    events: Optional[EventStream] = None  # assigned by main.py / test_video.py; None = nothing is sent
    snapshots = None    # SnapshotStore, assigned likewise; None = events carry no snapshot
    metric_fields: Dict[str, str] = {}  # status field -> metric name, averaged per minute

    def __init__(
        self,
        camera_id: str,
        camera_name: str,
        nx_camera_id: str,
        rule_config_path: Optional[str] = None,
        nx_client: Optional[NxClient] = None,
        model_name: str = "yolo11n.onnx",
        device: str = "cpu",
        roi: Optional[Any] = None,
        rules: Optional[Dict[str, Any]] = None
    ):
        self.camera_id = camera_id
        self.camera_name = camera_name
        self.nx_camera_id = nx_camera_id
        self.rule_config_path = rule_config_path
        self.nx_client = nx_client
        self.device = device

        # Live preview + health, read by core/api_server.py from another thread
        self._frame_lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self.last_frame_at = 0.0
        self.fps = 0.0
        self._pending: Optional[list] = None  # events raised inside run(), sent once the annotated frame exists
        self._open_intervals: Dict[str, str] = {}  # session id -> interval kind
        self._metrics = MinuteMetrics(self._send_metric)

        # 1. Load base rule parameters from YAML file if available
        self.rules = self._load_rules(rule_config_path) if rule_config_path else {}

        # 2. Merge inline rules overrides if specified
        if rules and isinstance(rules, dict):
            self.rules.update(rules)

        # 3. Merge inline ROI if specified
        if roi is not None:
            self._apply_inline_roi(roi)

        # 4. Input resolution (supports int 640 or [height, width] e.g. [736, 1280])
        self.imgsz = self.rules.get("imgsz", 640)

        # Load YOLO model
        logger.info(f"[{self.camera_name}] Loading vision model '{model_name}' (imgsz={self.imgsz}) on device '{device}'...")
        self.model = YOLO(resolve_model_path(model_name), task="detect")

    def _apply_inline_roi(self, roi: Any):
        """Applies inline ROI to rules configuration."""
        if isinstance(roi, dict):
            if "clerk_zone" in roi:
                self.rules["clerk_zone"] = roi["clerk_zone"]
            if "visitor_zone" in roi:
                self.rules["visitor_zone"] = roi["visitor_zone"]
            if "tripwire" in roi:
                self.rules["tripwire"] = roi["tripwire"]
            elif "start" in roi and "end" in roi:
                self.rules["tripwire"] = roi
            elif "zone_polygon" in roi:
                self.rules["zone_polygon"] = roi["zone_polygon"]
            elif "dining_zone" in roi:
                self.rules["dining_zone"] = roi["dining_zone"]
            elif "roi_polygon" in roi:
                self.rules["roi_polygon"] = roi["roi_polygon"]
            elif "clerk_zone" not in roi and "visitor_zone" not in roi:
                self.rules["zone_polygon"] = roi
        elif isinstance(roi, list):
            # List of polygon points [[x, y], ...]
            self.rules["zone_polygon"] = roi
            self.rules["dining_zone"] = roi
            self.rules["roi_polygon"] = roi

    def _load_rules(self, config_path: Optional[str]) -> Dict[str, Any]:
        """Loads rule configuration from YAML file."""
        if not config_path:
            return {}
        try:
            with open(config_path, "r") as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.error(f"Failed to load rule config {config_path}: {e}")
            return {}

    def emit(self, event_type: str, data: Dict[str, Any], severity: str = "info"):
        """Sends an event (no-op when no event stream is configured).
        Inside run(), events wait for the end of the frame so they can carry its snapshot."""
        if not self.events:
            return
        if self._pending is not None:
            self._pending.append((event_type, data, severity, int(time.time() * 1000)))
        else:
            self.events.send(event_message(
                self.camera_id, self.use_case, event_type, data, severity, time_ms=int(time.time() * 1000)
            ))

    def open_interval(
        self, kind: str, subject_id: Optional[str] = None, data: Optional[Dict[str, Any]] = None,
        time_ms: Optional[int] = None
    ) -> str:
        """Opens an interval and returns its session id (also when no event stream is configured)."""
        if time_ms is None:
            time_ms = int(time.time() * 1000)
        msg = interval_open_message(self.camera_id, self.use_case, kind, subject_id, data, time_ms)
        self._open_intervals[msg["sessionId"]] = kind
        if self.events:
            self.events.send(msg)
        return msg["sessionId"]

    def close_interval(self, session_id: str, data: Optional[Dict[str, Any]] = None, end_reason: str = "ended"):
        kind = self._open_intervals.pop(session_id, None)
        if kind is None:
            return
        if self.events:
            self.events.send(interval_close_message(
                self.camera_id, self.use_case, kind, session_id, data,
                time_ms=int(time.time() * 1000), end_reason=end_reason
            ))

    def emit_status(self, data: Dict[str, Any]):
        """Samples the numeric status fields listed in metric_fields; the minute means go out as metrics."""
        now = time.time()
        for field, name in self.metric_fields.items():
            value = data.get(field)
            if value is not None:
                self._metrics.sample(name, value, now)

    def shutdown(self):
        """Closes the open intervals and sends the metrics of the minute in progress."""
        for session_id in list(self._open_intervals):
            self.close_interval(session_id, end_reason="engine_stop")
        self._metrics.flush()

    def _send_metric(self, name: str, minute_ms: int, value: float):
        if self.events:
            self.events.send(metric_message(self.camera_id, self.use_case, name, minute_ms, value))

    def run(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        """process_frame() plus event snapshots, live preview frame and FPS."""
        annotated = None
        self._pending = []
        try:
            annotated = self.process_frame(frame, timestamp_ms)
            return annotated
        finally:
            pending, self._pending = self._pending, None
            shot = annotated if annotated is not None else frame
            for event_type, data, severity, ts in pending:
                self._send_with_evidence(event_type, data, severity, ts, shot)

            now = time.time()
            if annotated is not None:
                with self._frame_lock:
                    self._latest_frame = annotated
                dt = now - self.last_frame_at
                if 0 < dt < 10:
                    self.fps = 1 / dt if not self.fps else 0.9 * self.fps + 0.1 / dt
                self.last_frame_at = now

    def _send_with_evidence(self, event_type: str, data: Dict[str, Any], severity: str, ts: int, frame: np.ndarray):
        event_id = new_id("evt")
        rel = self.snapshots.save(self.camera_id, event_id, frame) if self.snapshots else None
        self.events.send(event_message(
            self.camera_id, self.use_case, event_type, data, severity,
            time_ms=ts, snapshot_path=rel, event_id=event_id
        ))

    def latest_frame(self) -> Optional[np.ndarray]:
        """Most recent annotated frame (do not modify it; the preview encodes it from another thread)."""
        with self._frame_lock:
            return self._latest_frame

    @abstractmethod
    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        """
        Process a single decoded video frame.
        Must return an annotated frame for visualization / debugging.
        """
        pass
