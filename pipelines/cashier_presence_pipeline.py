"""
Cashier Presence Pipeline (Phase 1 Quick Win).
Monitors the cashier desk ROI polygon. Flags unattended periods exceeding configured thresholds.
"""

import time
import logging
import cv2
import numpy as np
import supervision as sv
from typing import Optional, Any, Dict

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
        rules: Optional[dict] = None
    ):
        super().__init__(
            camera_id=camera_id,
            camera_name=camera_name,
            nx_camera_id=nx_camera_id,
            rule_config_path=rule_config_path,
            nx_client=nx_client,
            model_name="yolo11n.pt",
            device=device,
            roi=roi,
            rules=rules
        )

        self.conf_thresh = self.rules.get("confidence_threshold", 0.35)
        self.absence_timeout_sec = self.rules.get("absence_alert_timeout_sec", 10)
        self.debounce_alert_sec = self.rules.get("debounce_alert_sec", 30)

        # State tracking
        self.last_presence_time = time.time()
        self.last_alert_time = 0.0
        self.polygon_zone: Optional[sv.PolygonZone] = None
        self.zone_annotator: Optional[sv.PolygonZoneAnnotator] = None

    def _init_zone_if_needed(self, frame_shape):
        """Initializes supervision polygon zone using relative coordinates."""
        if self.polygon_zone is not None:
            return

        h, w = frame_shape[:2]
        raw_poly = self.rules.get("zone_polygon", [[0.2, 0.2], [0.8, 0.2], [0.8, 0.85], [0.2, 0.85]])
        
        # Scale normalized coordinates to actual frame pixels
        pixel_poly = np.array([[int(p[0] * w), int(p[1] * h)] for p in raw_poly], dtype=np.int32)
        
        self.polygon_zone = sv.PolygonZone(polygon=pixel_poly)
        self.zone_annotator = sv.PolygonZoneAnnotator(
            zone=self.polygon_zone,
            color=sv.Color.GREEN,
            thickness=2,
            text_thickness=1,
            text_scale=0.6
        )

    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        current_time = time.time()
        self._init_zone_if_needed(frame.shape)

        # Run inference filtering specifically for 'person' (COCO class 0)
        results = self.model(frame, classes=[0], conf=self.conf_thresh, verbose=False, device=self.device)[0]
        detections = sv.Detections.from_ultralytics(results)

        # Evaluate if any detected person is inside the cashier desk zone
        is_person_in_zone = self.polygon_zone.trigger(detections=detections)
        presence_detected = bool(np.any(is_person_in_zone))

        annotated_frame = frame.copy()

        if presence_detected:
            self.last_presence_time = current_time
            status_text = "STATUS: CASHIER PRESENT"
            status_color = (0, 255, 0) # Green
            self.zone_annotator.color = sv.Color.GREEN
        else:
            absent_duration = int(current_time - self.last_presence_time)
            status_text = f"STATUS: UNATTENDED ({absent_duration}s)"
            status_color = (0, 0, 255) if absent_duration >= self.absence_timeout_sec else (0, 165, 255)
            self.zone_annotator.color = sv.Color.RED if absent_duration >= self.absence_timeout_sec else sv.Color.from_hex("#FFA500")

            # Check if absence duration exceeds threshold and debounce has passed
            if absent_duration >= self.absence_timeout_sec:
                if current_time - self.last_alert_time >= self.debounce_alert_sec:
                    self._dispatch_absence_alert(absent_duration, timestamp_ms)
                    self.last_alert_time = current_time

        # Draw Zone and Diagnostics
        annotated_frame = self.zone_annotator.annotate(scene=annotated_frame)
        
        # Status banner overlay
        cv2.putText(annotated_frame, f"{self.camera_name}", (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.putText(annotated_frame, status_text, (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, status_color, 2)

        return annotated_frame

    def _dispatch_absence_alert(self, absent_duration: int, timestamp_ms: int):
        """Pushes an Nx Bookmark and Event when cashier desk is empty too long."""
        bm_config = self.rules.get("nx_bookmark", {})
        title = bm_config.get("title", "[STAFF ALERT] Cashier Desk Unattended")
        tag = bm_config.get("tag", "#cashier_unattended")
        description = f"Cashier desk unattended for {absent_duration} seconds at {self.camera_name}."

        logger.warning(f"[{self.camera_name}] DISPATCHING ABSENCE ALERT: {description}")

        # 1. Timeline Bookmark in Nx
        self.nx_client.create_bookmark(
            camera_id=self.nx_camera_id,
            title=title,
            description=description,
            tags=[tag, "#staff_alert"],
            start_time_ms=timestamp_ms - (absent_duration * 1000),
            duration_ms=bm_config.get("duration_ms", 10000)
        )

        # 2. Desktop Popup Event in Nx
        self.nx_client.create_event(
            event_type="AnalyticsEvent",
            source=self.camera_name,
            caption=title,
            description=description
        )
