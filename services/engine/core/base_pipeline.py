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

from core.analytics_dispatcher import new_event_id
from core.model_store import resolve_model_path
from nx_integration.nx_client import NxClient

logger = logging.getLogger("BasePipeline")

# Live-state heartbeat interval for the web dashboard (zoo-vision-fe src/lib/util.ts STATUS_SEC must match).
STATUS_INTERVAL_SEC = 30


class BasePipeline(ABC):
    use_case = ""       # dashboard use case id, set by each subclass
    analytics = None    # AnalyticsDispatcher, assigned by main.py / test_video.py; None = dashboard disabled
    snapshots = None    # SnapshotStore, assigned likewise; None = events carry no snapshot
    recording_path = None  # MediaMTX path that records this camera; lets the dashboard play the clip of an event
    _last_status = 0.0

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
        """Sends an event to the web dashboard (no-op when analytics is not configured).
        Inside run(), non-status events wait for the end of the frame so they can carry its snapshot."""
        if not self.analytics:
            return
        if self._pending is not None and event_type != "status":
            self._pending.append((event_type, data, severity, int(time.time() * 1000)))
        else:
            self.analytics.dispatch(
                self.use_case, event_type, self.camera_id, self.camera_name, data, severity, self.nx_camera_id
            )

    def emit_status(self, data: Dict[str, Any]):
        """Live state + heartbeat, at most once per STATUS_INTERVAL_SEC (wall clock)."""
        if self.analytics and time.time() - self._last_status >= STATUS_INTERVAL_SEC:
            self._last_status = time.time()
            self.emit("status", data)

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
        event_id = new_event_id()
        data = dict(data)
        if self.snapshots:
            rel = self.snapshots.save(self.camera_id, event_id, frame)
            if rel:
                data["snapshot"] = rel
        if self.recording_path:
            data["recordingPath"] = self.recording_path
        self.analytics.dispatch(
            self.use_case, event_type, self.camera_id, self.camera_name, data, severity, self.nx_camera_id,
            timestamp_ms=ts, event_id=event_id
        )

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
