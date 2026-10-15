"""
Abstract Base Pipeline for all Zoo Computer Vision attraction monitors.
Standardizes YOLO model loading, frame processing, and Nx Event dispatching.
main.py / test_video.py call run(), which wraps process_frame() with event snapshots and the live preview.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
import logging
import threading
import time
from typing import Any, ClassVar, Dict, Optional
import numpy as np
from pydantic import BaseModel

from contracts.boxes import Box, Boxes
from core.event_stream import EventStream
from core.messages import event_message, interval_close_message, interval_open_message, metric_message, new_id
from core.metrics import MinuteMetrics
from core.model_pool import Detector
from nx_integration.nx_client import NxClient

logger = logging.getLogger("BasePipeline")

NO_NX_CAMERA_ID = "00000000-0000-0000-0000-000000000000"  # Nx bookmark calls for a camera with no Nx id


@dataclass(frozen=True)
class CameraInfo:
    id: str
    name: str
    nx_camera_id: Optional[str] = None  # None -> NO_NX_CAMERA_ID in Nx bookmark calls


class BasePipeline(ABC):
    use_case: ClassVar[str] = ""  # contract use case id, set by each subclass
    metric_fields: ClassVar[Dict[str, str]] = {}  # status field -> metric name, averaged per minute
    events: Optional[EventStream] = None  # assigned by the camera worker / test_video.py; None = nothing is sent
    snapshots = None  # SnapshotStore, assigned likewise; None = events carry no snapshot
    boxes = None  # BoxPublisher, assigned by the camera worker; None = no boxes published

    def __init__(
        self,
        camera: CameraInfo,
        settings: BaseModel,
        model: Detector,
        *,
        device: str = "cpu",
        nx_client: Optional[NxClient] = None,
        config_version: Optional[int] = None,
    ):
        self.camera_id = camera.id
        self.camera_name = camera.name
        self.nx_camera_id = camera.nx_camera_id
        self.settings = settings
        self.model = model
        self.device = device
        self.nx_client = nx_client
        self.config_version = config_version

        # Latest frame, read by DebugPublisher and the live preview
        self._frame_lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self.last_frame_at = 0.0
        self.fps = 0.0
        self.live: Dict[str, Any] = {}  # the latest emit_status payload
        self._pending: Optional[list] = None  # events raised inside run(), sent once the annotated frame exists
        self._open_intervals: Dict[str, str] = {}  # session id -> interval kind
        self._metrics = MinuteMetrics(self._send_metric)

        logger.info(f"[{self.camera_name}] {self.use_case} pipeline ready (imgsz={settings.imgsz}, device='{device}').")

    @property
    def nx_id(self) -> str:
        """The camera id to put in Nx bookmark calls."""
        return self.nx_camera_id or NO_NX_CAMERA_ID

    def emit(self, event_type: str, data: Dict[str, Any], severity: str = "info"):
        """Sends an event (no-op when no event stream is configured).
        Inside run(), events wait for the end of the frame so they can carry its snapshot."""
        if not self.events:
            return
        if self._pending is not None:
            self._pending.append((event_type, data, severity, int(time.time() * 1000)))
        else:
            self.events.send(event_message(
                self.camera_id, self.use_case, event_type, data, severity, time_ms=int(time.time() * 1000),
                config_version=self.config_version
            ))

    def open_interval(
        self, kind: str, subject_id: Optional[str] = None, data: Optional[Dict[str, Any]] = None,
        time_ms: Optional[int] = None
    ) -> str:
        """Opens an interval and returns its session id (also when no event stream is configured)."""
        if time_ms is None:
            time_ms = int(time.time() * 1000)
        msg = interval_open_message(
            self.camera_id, self.use_case, kind, subject_id, data, time_ms, config_version=self.config_version
        )
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
                time_ms=int(time.time() * 1000), end_reason=end_reason, config_version=self.config_version
            ))

    def emit_status(self, data: Dict[str, Any]):
        """Samples the numeric status fields listed in metric_fields; the minute means go out as metrics."""
        self.live = data
        now = time.time()
        for field, name in self.metric_fields.items():
            value = data.get(field)
            if value is not None:
                self._metrics.sample(name, value, now)

    def apply_config(self, settings: BaseModel, config_version: Optional[int]) -> None:
        """Swaps in new settings between two frames; _on_settings rebuilds what the change needs.
        Thresholds, display flags and the Nx bookmark are read from self.settings on every frame."""
        old = self.settings
        self.settings = settings
        self.config_version = config_version
        self._on_settings(old, settings)

    def _on_settings(self, old: BaseModel, new: BaseModel) -> None:
        """Subclass hook: rebuild only what the change from `old` to `new` needs, keeping counts and state."""

    def set_model(self, model: Detector) -> Detector:
        """Swaps the detector between two frames (trackers and counts stay); returns the previous one."""
        previous, self.model = self.model, model
        self._on_model()
        return previous

    def _on_model(self) -> None:
        """Subclass hook: re-derive anything read from the detector (class ids)."""

    @staticmethod
    def changed(old: BaseModel, new: BaseModel, *fields: str) -> bool:
        return any(getattr(old, f, None) != getattr(new, f, None) for f in fields)

    def shutdown(self, end_reason: str = "engine_stop") -> None:
        """Closes the open intervals and sends the metrics of the minute in progress."""
        for session_id in list(self._open_intervals):
            self.close_interval(session_id, end_reason=end_reason)
        self._metrics.flush()

    def _send_metric(self, name: str, minute_ms: int, value: float):
        if self.events:
            self.events.send(metric_message(
                self.camera_id, self.use_case, name, minute_ms, value, config_version=self.config_version
            ))

    def run(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        """process_frame() plus event snapshots, live preview frame and FPS."""
        annotated = None
        self._pending = []
        self._current_frame_size = frame.shape[:2]
        self._current_timestamp_ms = timestamp_ms
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
            time_ms=ts, snapshot_path=rel, event_id=event_id, config_version=self.config_version
        ))

    def publish_boxes(self, detections: Any, labels: Optional[list[str]] = None) -> None:
        """Builds Boxes and offers them to the box publisher (no-op when self.boxes is None)."""
        if not self.boxes:
            return
        h, w = getattr(self, "_current_frame_size", (1, 1))
        if h <= 0 or w <= 0:
            return
        t = getattr(self, "_current_timestamp_ms", int(time.time() * 1000))

        box_list = []
        if detections is not None and len(detections) > 0:
            xyxy = detections.xyxy
            track_ids = (
                detections.tracker_id
                if detections.tracker_id is not None
                else [None] * len(detections)
            )
            class_ids = (
                detections.class_id
                if detections.class_id is not None
                else [0] * len(detections)
            )

            count = min(len(detections), 300)
            for i in range(count):
                box = xyxy[i]
                tid = track_ids[i]
                cls = int(class_ids[i]) if class_ids[i] is not None else 0

                # Coordinates divided by w/h and clamped to 0–1
                x1 = max(0.0, min(1.0, float(box[0]) / w))
                y1 = max(0.0, min(1.0, float(box[1]) / h))
                x2 = max(0.0, min(1.0, float(box[2]) / w))
                y2 = max(0.0, min(1.0, float(box[3]) / h))

                if labels is not None and i < len(labels):
                    lbl = str(labels[i])
                elif (
                    hasattr(self.model, "names")
                    and isinstance(self.model.names, dict)
                    and cls in self.model.names
                ):
                    lbl = str(self.model.names[cls])
                elif (
                    hasattr(self.model, "names")
                    and isinstance(self.model.names, (list, tuple))
                    and 0 <= cls < len(self.model.names)
                ):
                    lbl = str(self.model.names[cls])
                else:
                    lbl = str(cls)

                box_list.append(
                    Box(
                        trackId=int(tid) if tid is not None else None,
                        cls=cls,
                        label=lbl,
                        x1=x1,
                        y1=y1,
                        x2=x2,
                        y2=y2,
                    )
                )

        payload = Boxes(cameraId=self.camera_id, t=t, boxes=box_list)
        self.boxes.offer(self.camera_id, payload.model_dump(mode="json"))

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
