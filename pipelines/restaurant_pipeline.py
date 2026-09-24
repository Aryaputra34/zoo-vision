"""
Restaurant People Counter & Area Occupancy Pipeline.
Supports dual operational modes:
1. 'area_occupancy': Real-time dining area headcount using YOLO26 + PolygonZone + temporal smoothing.
2. 'tripwire': Doorway pedestrian flow counter (In / Out) using YOLO + ByteTrack + LineZone.
"""

import time
import logging
import collections
import cv2
import numpy as np
import supervision as sv
from typing import Optional, List, Tuple, Any, Dict
import yaml

from core.base_pipeline import BasePipeline
from nx_integration.nx_client import NxClient

logger = logging.getLogger("RestaurantPipeline")


class RestaurantCounterPipeline(BasePipeline):
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

        self.mode = self.rules.get("mode", "area_occupancy")
        self.imgsz = self.rules.get("imgsz", 1920)
        self.conf_thresh = self.rules.get("confidence_threshold", 0.20)
        self.max_capacity = self.rules.get("max_capacity", 60)
        self.warning_capacity = self.rules.get("warning_capacity", 45)
        self.debounce_alert_sec = self.rules.get("debounce_alert_sec", 60)

        # Shadow Boost Zone configuration for difficult bamboo wall tables
        self.shadow_cfg = self.rules.get("shadow_zone", {})
        self.shadow_enabled = self.shadow_cfg.get("enabled", False)
        self.shadow_conf = float(self.shadow_cfg.get("confidence_threshold", 0.11))
        self.shadow_box: Optional[Tuple[int, int, int, int]] = None

        # Anti-Duplicate & Anti-Flicker Settings
        self.deduplication_enabled = bool(self.rules.get("deduplication_enabled", True))
        self.iou_threshold = float(self.rules.get("iou_threshold", 0.45))
        self.containment_threshold = float(self.rules.get("containment_threshold", 0.65))
        self.tracking_enabled = bool(self.rules.get("tracking_enabled", True))
        self.lost_track_buffer = int(self.rules.get("lost_track_buffer", 30))
        self.smoothing_frames = int(self.rules.get("smoothing_frames", 5))

        # Annotators
        self.box_annotator = sv.BoxAnnotator(thickness=2)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.45, text_thickness=1)

        # Multi-Object Tracker & Temporal Smoother
        self.tracker = sv.ByteTrack(
            track_activation_threshold=self.conf_thresh,
            lost_track_buffer=self.lost_track_buffer,
            minimum_matching_threshold=0.8,
            frame_rate=15,
            minimum_consecutive_frames=1
        ) if (self.tracking_enabled or self.mode == "tripwire") else None
        self.smoother = sv.DetectionsSmoother(length=self.smoothing_frames) if self.tracking_enabled else None

        # Area Occupancy Mode State
        self.polygon_zone: Optional[sv.PolygonZone] = None
        self.zone_annotator: Optional[sv.PolygonZoneAnnotator] = None
        self.smoothing_window_sec = float(self.rules.get("smoothing_window_sec", 4.0))
        self.count_history = collections.deque() # (timestamp, raw_count)
        self.current_occupancy = 0
        self.raw_occupancy = 0
        self.last_alert_time = 0.0

        # Tripwire Mode State
        self.line_zone: Optional[sv.LineZone] = None
        self.line_zone_annotator: Optional[sv.LineZoneAnnotator] = None

        self.last_periodic_log = time.time()
        logger.info(
            f"[{self.camera_name}] Initialized Restaurant Pipeline in '{self.mode}' mode "
            f"using model '{model_name}' (imgsz={self.imgsz}, conf={self.conf_thresh}, "
            f"tracking={self.tracking_enabled}, deduplication={self.deduplication_enabled})."
        )

    def _suppress_duplicates(self, detections: sv.Detections) -> sv.Detections:
        """
        Suppresses duplicate person detections caused by part-vs-whole detections
        (e.g., upper body/torso detected as one person and full body as another):
        1. Tighter IoU Non-Maximum Suppression (iou_threshold).
        2. Containment / IoMin suppression (containment_threshold): if a smaller box
           is largely contained inside a larger box, suppress the lower-confidence box.
        """
        if not self.deduplication_enabled or len(detections) <= 1:
            return detections

        # 1. Stricter IoU Non-Maximum Suppression
        dets = detections.with_nms(threshold=self.iou_threshold)
        if len(dets) <= 1:
            return dets

        # 2. Containment / IoMin suppression (e.g. torso inside full body)
        boxes = dets.xyxy
        confs = dets.confidence if dets.confidence is not None else np.ones(len(boxes))
        order = np.argsort(-confs)
        keep = []

        for idx in order:
            box = boxes[idx]
            area = (box[2] - box[0]) * (box[3] - box[1])
            discard = False
            for k in keep:
                k_box = boxes[k]
                k_area = (k_box[2] - k_box[0]) * (k_box[3] - k_box[1])
                xi1 = max(box[0], k_box[0])
                yi1 = max(box[1], k_box[1])
                xi2 = min(box[2], k_box[2])
                yi2 = min(box[3], k_box[3])
                iw = max(0, xi2 - xi1)
                ih = max(0, yi2 - yi1)
                inter = iw * ih
                min_area = min(area, k_area)
                if min_area > 0 and (inter / min_area) > self.containment_threshold:
                    discard = True
                    break
            if not discard:
                keep.append(idx)

        return dets[np.array(sorted(keep), dtype=int)]

    # =========================================================================
    # ZONE & TRIPWIRE INITIALIZERS
    # =========================================================================

    def _init_area_zone_if_needed(self, frame_shape: Tuple[int, int]):
        if self.polygon_zone is not None:
            return

        h, w = frame_shape[:2]
        raw_poly = self.rules.get("dining_zone")
        if raw_poly:
            pixel_poly = np.array([[int(p[0] * w), int(p[1] * h)] for p in raw_poly], dtype=np.int32)
        else:
            # Default to full frame if no polygon provided
            pixel_poly = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.int32)

        self.polygon_zone = sv.PolygonZone(
            polygon=pixel_poly,
            triggering_anchors=[sv.Position.BOTTOM_CENTER, sv.Position.CENTER]
        )
        self.zone_annotator = sv.PolygonZoneAnnotator(
            zone=self.polygon_zone,
            color=sv.Color.GREEN,
            thickness=2
        )

        # Initialize shadow boost zone if configured
        if self.shadow_enabled:
            s = self.shadow_cfg.get("start", [1.00, 0.48])
            e = self.shadow_cfg.get("end", [0.82, 0.17])
            x1 = int(min(s[0], e[0]) * w)
            x2 = int(max(s[0], e[0]) * w)
            y1 = int(min(s[1], e[1]) * h)
            y2 = int(max(s[1], e[1]) * h)
            self.shadow_box = (x1, y1, x2, y2)
            logger.info(
                f"[{self.camera_name}] Activated shadow boost zone: "
                f"x=[{x1}, {x2}], y=[{y1}, {y2}] (conf >= {self.shadow_conf})"
            )

    def _init_tripwire_if_needed(self, frame_shape: Tuple[int, int]):
        if self.line_zone is not None:
            return

        h, w = frame_shape[:2]
        raw_start = self.rules.get("tripwire", {}).get("start", [0.1, 0.5])
        raw_end = self.rules.get("tripwire", {}).get("end", [0.9, 0.5])

        start_pt = sv.Point(x=int(raw_start[0] * w), y=int(raw_start[1] * h))
        end_pt = sv.Point(x=int(raw_end[0] * w), y=int(raw_end[1] * h))

        self.line_zone = sv.LineZone(
            start=start_pt,
            end=end_pt,
            triggering_anchors=[sv.Position.BOTTOM_CENTER]
        )
        self.line_zone_annotator = sv.LineZoneAnnotator(
            thickness=2,
            text_thickness=1,
            text_scale=0.7,
            custom_in_text="IN",
            custom_out_text="OUT"
        )

    # =========================================================================
    # FRAME PROCESSING
    # =========================================================================

    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        if self.mode == "area_occupancy":
            return self._process_area_occupancy(frame, timestamp_ms)
        else:
            return self._process_tripwire(frame, timestamp_ms)

    def _process_area_occupancy(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        self._init_area_zone_if_needed(frame.shape)
        now_sec = timestamp_ms / 1000.0 if timestamp_ms > 0 else time.time()

        # 1. Run YOLO inference for 'person' (COCO class 0)
        # When tracking is enabled, use a slightly lower floor so ByteTrack's 2nd association stage
        # can recover occluded/moving frames without flickering.
        base_inference_conf = min(self.conf_thresh * 0.75, 0.15) if self.tracking_enabled else self.conf_thresh
        inference_conf = min(base_inference_conf, self.shadow_conf) if self.shadow_enabled else base_inference_conf

        results = self.model(
            frame,
            classes=[0],
            conf=inference_conf,
            imgsz=self.imgsz,
            verbose=False,
            device=self.device
        )[0]
        detections = sv.Detections.from_ultralytics(results)

        # 2. Spatially filter detections with dual-confidence thresholding
        if self.shadow_enabled and self.shadow_box is not None and len(detections) > 0:
            sx1, sy1, sx2, sy2 = self.shadow_box
            keep_mask = []
            for xyxy, conf in zip(detections.xyxy, detections.confidence):
                cx = (xyxy[0] + xyxy[2]) / 2.0
                cy = (xyxy[1] + xyxy[3]) / 2.0
                in_shadow = (sx1 <= cx <= sx2 and sy1 <= cy <= sy2)
                if in_shadow:
                    keep_mask.append(conf >= self.shadow_conf)
                else:
                    keep_mask.append(conf >= base_inference_conf)
            detections = detections[np.array(keep_mask, dtype=bool)]

        # 3. Deduplicate overlapping and nested boxes (prevents 1 person counted as 2)
        detections = self._suppress_duplicates(detections)

        # 4. Multi-Object Tracking & Smoothing (eliminates flickering across frames)
        if self.tracking_enabled and self.tracker is not None:
            tracked_detections = self.tracker.update_with_detections(detections)
            if self.smoother is not None and len(tracked_detections) > 0:
                tracked_detections = self.smoother.update_with_detections(tracked_detections)
            active_detections = tracked_detections
        else:
            active_detections = detections

        # 5. Filter detections inside dining area polygon
        is_in_zone = self.polygon_zone.trigger(detections=active_detections)
        zone_detections = active_detections[is_in_zone]
        self.raw_occupancy = len(zone_detections)

        # 6. Temporal rolling median smoothing
        self.count_history.append((now_sec, self.raw_occupancy))
        cutoff = now_sec - self.smoothing_window_sec
        while self.count_history and self.count_history[0][0] < cutoff:
            self.count_history.popleft()

        counts = [c for _, c in self.count_history]
        self.current_occupancy = int(round(float(np.median(counts)))) if counts else self.raw_occupancy

        # 7. Check capacity thresholds & dispatch alarms
        self._check_capacity_alerts(self.current_occupancy, timestamp_ms)

        # 8. Render visualizations
        annotated_frame = frame.copy()
        
        # Color coding for zone & HUD
        if self.current_occupancy >= self.max_capacity:
            status_text = "ALERT: RESTAURANT FULL"
            status_color = (0, 0, 255) # Red
            zone_color = sv.Color.RED
        elif self.current_occupancy >= self.warning_capacity:
            status_text = "WARNING: NEAR CAPACITY"
            status_color = (0, 165, 255) # Orange
            zone_color = sv.Color.from_hex("#FFA500")
        else:
            status_text = "NORMAL CAPACITY"
            status_color = (0, 255, 0) # Green
            zone_color = sv.Color.GREEN

        # Draw zone boundary
        if self.zone_annotator and self.rules.get("dining_zone"):
            self.zone_annotator.color = zone_color
            annotated_frame = self.zone_annotator.annotate(scene=annotated_frame)

        # Draw shadow boost zone outline
        if self.shadow_enabled and self.shadow_box is not None:
            sx1, sy1, sx2, sy2 = self.shadow_box
            cv2.rectangle(annotated_frame, (sx1, sy1), (sx2, sy2), (0, 215, 255), 1, cv2.LINE_AA)
            cv2.putText(
                annotated_frame,
                "BAMBOO WALL ZONE",
                (sx1 + 6, sy1 + 18),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.42,
                (0, 215, 255),
                1,
                cv2.LINE_AA
            )

        # Annotate detected people in dining zone
        annotated_frame = self.box_annotator.annotate(annotated_frame, detections=zone_detections)
        if len(zone_detections) > 0:
            if hasattr(zone_detections, "tracker_id") and zone_detections.tracker_id is not None:
                labels = [
                    f"#{tid} ({conf:.2f})" if tid is not None else f"person {conf:.2f}"
                    for tid, conf in zip(zone_detections.tracker_id, zone_detections.confidence)
                ]
            else:
                labels = [f"person {conf:.2f}" for conf in zone_detections.confidence]
            annotated_frame = self.label_annotator.annotate(annotated_frame, detections=zone_detections, labels=labels)

        # Draw Premium HUD
        annotated_frame = self._render_occupancy_hud(
            annotated_frame,
            occupancy=self.current_occupancy,
            raw_occupancy=self.raw_occupancy,
            status_text=status_text,
            status_color=status_color
        )

        return annotated_frame

    def _process_tripwire(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        self._init_tripwire_if_needed(frame.shape)

        # Detection + ByteTrack
        results = self.model(frame, classes=[0], conf=self.conf_thresh, imgsz=self.imgsz, verbose=False, device=self.device)[0]
        detections = sv.Detections.from_ultralytics(results)
        detections = self._suppress_duplicates(detections)
        if self.tracker is None:
            self.tracker = sv.ByteTrack()
        detections = self.tracker.update_with_detections(detections)

        crossed_in, crossed_out = self.line_zone.trigger(detections=detections)
        self.current_occupancy = max(0, self.line_zone.in_count - self.line_zone.out_count)

        if np.any(crossed_in) or np.any(crossed_out):
            self._check_capacity_alerts(self.current_occupancy, timestamp_ms)

        annotated_frame = frame.copy()
        annotated_frame = self.line_zone_annotator.annotate(annotated_frame, line_counter=self.line_zone)
        annotated_frame = self.box_annotator.annotate(annotated_frame, detections=detections)
        labels = [f"#{tid}" for tid in detections.tracker_id] if detections.tracker_id is not None else []
        annotated_frame = self.label_annotator.annotate(annotated_frame, detections=detections, labels=labels)

        occ_color = (0, 0, 255) if self.current_occupancy >= self.max_capacity else (0, 255, 0)
        cv2.putText(annotated_frame, f"{self.camera_name}", (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.putText(annotated_frame, f"OCCUPANCY: {self.current_occupancy} / {self.max_capacity}", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, occ_color, 2)
        return annotated_frame

    # =========================================================================
    # ALERTS & HUD
    # =========================================================================

    def _check_capacity_alerts(self, current_occupancy: int, timestamp_ms: int):
        now = time.time()
        if now - self.last_alert_time < self.debounce_alert_sec:
            return

        if current_occupancy >= self.max_capacity:
            self._dispatch_capacity_alert(current_occupancy, timestamp_ms, is_full=True)
            self.last_alert_time = now
        elif current_occupancy >= self.warning_capacity:
            self._dispatch_capacity_alert(current_occupancy, timestamp_ms, is_full=False)
            self.last_alert_time = now

    def _dispatch_capacity_alert(self, current_occupancy: int, timestamp_ms: int, is_full: bool):
        title = "[CAPACITY ALERT] Restaurant Full!" if is_full else "[CAPACITY NOTICE] Restaurant Near Limit"
        desc = f"Occupancy reached {current_occupancy}/{self.max_capacity} at {self.camera_name}."

        logger.warning(f"[{self.camera_name}] DISPATCHING CAPACITY ALERT: {desc}")
        self.nx_client.create_bookmark(
            camera_id=self.nx_camera_id,
            title=title,
            description=desc,
            tags=["#restaurant_capacity", "#capacity_alert"],
            start_time_ms=timestamp_ms,
            duration_ms=10000
        )

    def _render_occupancy_hud(
        self,
        frame: np.ndarray,
        occupancy: int,
        raw_occupancy: int,
        status_text: str,
        status_color: Tuple[int, int, int]
    ) -> np.ndarray:
        """Renders an attractive, high-contrast HUD panel at the top-left."""
        h, w = frame.shape[:2]
        
        # Draw translucent background card
        card_w = 460
        card_h = 100
        sub_img = frame[15:15 + card_h, 15:15 + card_w]
        dark_rect = np.full(sub_img.shape, 20, dtype=np.uint8)
        frame[15:15 + card_h, 15:15 + card_w] = cv2.addWeighted(sub_img, 0.35, dark_rect, 0.65, 0)

        # Title & Model
        cv2.putText(frame, f"{self.camera_name}", (25, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
        cv2.putText(frame, f"MODE: AREA HEADCOUNT (YOLO26)", (25, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 180, 180), 1)

        # Occupancy text
        pct = int((occupancy / max(1, self.max_capacity)) * 100)
        occ_str = f"OCCUPANCY: {occupancy} / {self.max_capacity} ({pct}%)"
        cv2.putText(frame, occ_str, (25, 92), cv2.FONT_HERSHEY_SIMPLEX, 0.8, status_color, 2)

        # Status badge on the right of the card
        cv2.putText(frame, f"[{status_text}]", (250, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.5, status_color, 1)

        return frame
