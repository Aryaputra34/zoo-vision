"""
Cashier Presence & Customer Service Monitoring Pipeline.
Monitors the cashier desk ROI polygon (clerk presence) and optional visitor queue polygon.
Tracks operational states:
1. SERVING CUSTOMER: Clerk present + Visitor at window
2. CASHIER PRESENT (IDLE): Clerk at desk, ready for customers
3. DESK UNATTENDED: Clerk absent exceeding configured timeout
4. CUSTOMER WAITING (ALERT): Visitor at counter while clerk is absent (High Priority)
"""

import time
import logging
import yaml
import cv2
import numpy as np
import supervision as sv
from typing import Optional, Any, Dict, List

from core.base_pipeline import BasePipeline
from nx_integration.nx_client import NxClient

logger = logging.getLogger("CashierPipeline")


class CashierPresencePipeline(BasePipeline):
    def __init__(
        self,
        camera_id: str,
        camera_name: str,
        nx_camera_id: str,
        rule_config_path: Optional[str] = None,
        nx_client: Optional[NxClient] = None,
        device: str = "cpu",
        roi: Optional[Any] = None,
        rules: Optional[Dict[str, Any]] = None
    ):
        # Pre-read model_name from rules config if available
        model_name = "yolo11s.onnx"
        if rules and "model_name" in rules:
            model_name = rules["model_name"]
        elif rule_config_path:
            try:
                with open(rule_config_path, "r") as f:
                    cfg = yaml.safe_load(f) or {}
                    model_name = cfg.get("model_name", "yolo11s.onnx")
            except Exception:
                pass

        super().__init__(
            camera_id=camera_id,
            camera_name=camera_name,
            nx_camera_id=nx_camera_id,
            rule_config_path=rule_config_path,
            nx_client=nx_client,
            model_name=model_name,
            device=device,
            roi=roi,
            rules=rules
        )

        self.conf_thresh = float(self.rules.get("confidence_threshold", 0.22))
        self.absence_timeout_sec = int(self.rules.get("absence_alert_timeout_sec", 10))
        self.visitor_waiting_timeout_sec = int(self.rules.get("visitor_waiting_alert_timeout_sec", 5))
        self.min_waiting_confirm_sec = int(self.rules.get("min_waiting_confirm_sec", 3))
        self.debounce_alert_sec = int(self.rules.get("debounce_alert_sec", 30))

        # State tracking
        self.last_presence_time = 0.0
        self.last_visitor_waiting_time = 0.0
        self.last_alert_time = 0.0
        self.current_state = "INIT"
        self.clerk_present = False
        self.visitor_present = False

        # Supervision Zones & Annotators
        self.clerk_zone: Optional[sv.PolygonZone] = None
        self.visitor_zone: Optional[sv.PolygonZone] = None
        self.clerk_annotator: Optional[sv.PolygonZoneAnnotator] = None
        self.visitor_annotator: Optional[sv.PolygonZoneAnnotator] = None
        self.box_annotator = sv.BoxAnnotator(thickness=2)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.5, text_thickness=1)

        logger.info(
            f"[{self.camera_name}] Initialized Cashier Pipeline with model '{model_name}' "
            f"(conf={self.conf_thresh}, absence_timeout={self.absence_timeout_sec}s)."
        )

    def _init_zones_if_needed(self, frame_shape):
        """Initializes supervision polygon zones for clerk desk and optional visitor window."""
        if self.clerk_zone is not None:
            return

        h, w = frame_shape[:2]

        # 1. Clerk Desk Zone (default or configured)
        clerk_raw = self.rules.get(
            "clerk_zone",
            self.rules.get("zone_polygon", [[0.33, 0.46], [0.72, 0.46], [0.72, 1.00], [0.33, 1.00]])
        )
        clerk_pixel = np.array([[int(p[0] * w), int(p[1] * h)] for p in clerk_raw], dtype=np.int32)
        self.clerk_poly_pts = clerk_pixel
        self.clerk_zone = sv.PolygonZone(
            polygon=clerk_pixel,
            triggering_anchors=[sv.Position.CENTER, sv.Position.BOTTOM_CENTER]
        )
        self.clerk_annotator = sv.PolygonZoneAnnotator(
            zone=self.clerk_zone,
            color=sv.Color.GREEN,
            thickness=2,
            text_scale=0.6
        )

        # 2. Visitor Queue Zone (optional)
        visitor_raw = self.rules.get("visitor_zone")
        if visitor_raw:
            visitor_pixel = np.array([[int(p[0] * w), int(p[1] * h)] for p in visitor_raw], dtype=np.int32)
            self.visitor_poly_pts = visitor_pixel
            self.visitor_zone = sv.PolygonZone(
                polygon=visitor_pixel,
                triggering_anchors=[sv.Position.CENTER, sv.Position.BOTTOM_CENTER]
            )
            self.visitor_annotator = sv.PolygonZoneAnnotator(
                zone=self.visitor_zone,
                color=sv.Color.from_hex("#00BFFF"), # Deep sky blue
                thickness=2,
                text_scale=0.6
            )

    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        # Use stream/video timestamp if provided, fallback to system wall clock
        current_time = (timestamp_ms / 1000.0) if (timestamp_ms and timestamp_ms > 0) else time.time()
        if self.last_presence_time == 0.0:
            self.last_presence_time = current_time

        self._init_zones_if_needed(frame.shape)

        # 1. Run YOLO inference specifically for 'person' (COCO class 0)
        results = self.model(
            frame,
            classes=[0],
            conf=self.conf_thresh,
            imgsz=self.imgsz,
            verbose=False,
            device=self.device
        )[0]
        detections = sv.Detections.from_ultralytics(results)

        # 2. Evaluate zones
        is_clerk = self.clerk_zone.trigger(detections=detections)
        self.clerk_present = bool(np.any(is_clerk))
        clerk_count = int(np.sum(is_clerk))

        visitor_count = 0
        if self.visitor_zone is not None:
            is_visitor = self.visitor_zone.trigger(detections=detections)
            self.visitor_present = bool(np.any(is_visitor))
            visitor_count = int(np.sum(is_visitor))
        else:
            self.visitor_present = False

        # 3. Determine Operational State & Handle Alerts
        annotated_frame = frame.copy()

        if self.clerk_present:
            self.last_presence_time = current_time
            self.last_visitor_waiting_time = 0.0

            if self.visitor_present:
                self.current_state = "SERVING CUSTOMER"
                status_color = (255, 191, 0) # Sky blue in BGR
                self.clerk_annotator.color = sv.Color.from_hex("#00BFFF")
            else:
                self.current_state = "CASHIER PRESENT (IDLE)"
                status_color = (0, 255, 0) # Green
                self.clerk_annotator.color = sv.Color.GREEN
        else:
            absent_duration = int(current_time - self.last_presence_time)

            if self.visitor_present:
                if self.last_visitor_waiting_time == 0.0:
                    self.last_visitor_waiting_time = current_time
                waiting_duration = int(current_time - self.last_visitor_waiting_time)

                # Only declare ALERT: CUSTOMER WAITING if stationary for >= min_waiting_confirm_sec
                if waiting_duration >= self.min_waiting_confirm_sec:
                    self.current_state = f"ALERT: CUSTOMER WAITING ({waiting_duration}s)"
                    status_color = (0, 0, 255) # Red
                    self.clerk_annotator.color = sv.Color.RED

                    # High-priority alert if customer waiting while clerk is absent
                    if waiting_duration >= self.visitor_waiting_timeout_sec:
                        if current_time - self.last_alert_time >= self.debounce_alert_sec:
                            self._dispatch_customer_waiting_alert(waiting_duration, timestamp_ms)
                            self.last_alert_time = current_time
                else:
                    # Still verifying if transient passerby or stationary waiting customer
                    self.current_state = f"STATUS: UNATTENDED ({absent_duration}s)"
                    status_color = (0, 0, 255) if absent_duration >= self.absence_timeout_sec else (0, 165, 255)
                    self.clerk_annotator.color = sv.Color.RED if absent_duration >= self.absence_timeout_sec else sv.Color.from_hex("#FFA500")
            else:
                self.last_visitor_waiting_time = 0.0
                if absent_duration >= self.absence_timeout_sec:
                    self.current_state = f"STATUS: UNATTENDED ({absent_duration}s)"
                    status_color = (0, 0, 255) # Red
                    self.clerk_annotator.color = sv.Color.RED

                    if current_time - self.last_alert_time >= self.debounce_alert_sec:
                        self._dispatch_absence_alert(absent_duration, timestamp_ms)
                        self.last_alert_time = current_time
                else:
                    self.current_state = f"STATUS: UNATTENDED ({absent_duration}s)"
                    status_color = (0, 165, 255) # Orange
                    self.clerk_annotator.color = sv.Color.from_hex("#FFA500")

        # 4. Annotate Scene
        annotated_frame = self.clerk_annotator.annotate(scene=annotated_frame)
        if self.visitor_annotator is not None:
            annotated_frame = self.visitor_annotator.annotate(scene=annotated_frame)

        # Draw person detection bounding boxes & confidence labels
        labels = [f"person {c:.2f}" for c in detections.confidence]
        annotated_frame = self.box_annotator.annotate(scene=annotated_frame, detections=detections)
        annotated_frame = self.label_annotator.annotate(scene=annotated_frame, detections=detections, labels=labels)

        # 5. Diagnostic Top HUD Overlay
        w = frame.shape[1]
        cv2.rectangle(annotated_frame, (0, 0), (w, 80), (25, 25, 25), -1)
        cv2.putText(
            annotated_frame,
            f"{self.camera_name} | Clerk: {clerk_count} | Visitor: {visitor_count}",
            (25, 32),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.75,
            (255, 255, 255),
            2
        )
        cv2.putText(
            annotated_frame,
            self.current_state,
            (25, 68),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.85,
            status_color,
            2
        )

        return annotated_frame

    def _dispatch_absence_alert(self, absent_duration: int, timestamp_ms: int):
        """Pushes an Nx Bookmark and Event when cashier desk is empty too long."""
        if not self.nx_client:
            return

        bm_config = self.rules.get("nx_bookmark", {})
        title = bm_config.get("title", "[STAFF ALERT] Cashier Desk Unattended")
        tag = bm_config.get("tag", "#cashier_unattended")
        description = f"Cashier desk unattended for {absent_duration} seconds at {self.camera_name}."

        logger.warning(f"[{self.camera_name}] DISPATCHING ABSENCE ALERT: {description}")

        self.nx_client.create_bookmark(
            camera_id=self.nx_camera_id,
            title=title,
            description=description,
            tags=[tag, "#staff_alert"],
            start_time_ms=timestamp_ms - (absent_duration * 1000),
            duration_ms=bm_config.get("duration_ms", 10000)
        )
        self.nx_client.create_event(
            event_type="AnalyticsEvent",
            source=self.camera_name,
            caption=title,
            description=description
        )

    def _dispatch_customer_waiting_alert(self, waiting_duration: int, timestamp_ms: int):
        """Pushes high-priority alert when customer is waiting while desk is empty."""
        if not self.nx_client:
            return

        title = "[URGENT STAFF ALERT] Customer Waiting at Unattended Desk"
        tag = "#customer_waiting_unattended"
        description = f"Customer has been waiting for {waiting_duration} seconds at unattended counter {self.camera_name}."

        logger.warning(f"[{self.camera_name}] DISPATCHING CUSTOMER WAITING ALERT: {description}")

        self.nx_client.create_bookmark(
            camera_id=self.nx_camera_id,
            title=title,
            description=description,
            tags=[tag, "#staff_alert", "#urgent"],
            start_time_ms=timestamp_ms - (waiting_duration * 1000),
            duration_ms=10000
        )
        self.nx_client.create_event(
            event_type="AnalyticsEvent",
            source=self.camera_name,
            caption=title,
            description=description
        )
