"""
Horse Riding Attraction Tracking & Ride Audit Pipeline.
Tracks horses with ByteTrack, maintains persistent tracking IDs and motion trajectories,
and logs ride departure events for revenue reconciliation.
"""

import time
import logging
from typing import Any, Optional, Dict, List, Tuple
import cv2
import numpy as np
import supervision as sv
import yaml

from core.base_pipeline import BasePipeline
from nx_integration.nx_client import NxClient

logger = logging.getLogger("HorseRidingPipeline")


class HorseRidingPipeline(BasePipeline):
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
        # 1. Determine model name from overrides or rule config
        model_name = "yolo11m.pt"
        if rules and "model_name" in rules:
            model_name = rules["model_name"]
        elif rule_config_path:
            try:
                with open(rule_config_path, "r") as f:
                    cfg = yaml.safe_load(f) or {}
                    model_name = cfg.get("model_name", "yolo11m.pt")
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

        self.conf_thresh = float(self.rules.get("confidence_threshold", 0.35))
        self.track_horses_only = bool(self.rules.get("track_horses_only", True))

        # 2. Resolve class IDs from loaded YOLO model
        # Target 'horse' dynamically to support both COCO and custom fine-tuned weights
        self.horse_class_ids = [
            cid for cid, cname in self.model.names.items()
            if "horse" in cname.lower()
        ]
        if not self.horse_class_ids:
            # Fallback to COCO class 17 (horse) if names dictionary lacks it
            self.horse_class_ids = [17]
        logger.info(f"[{self.camera_name}] Target horse class ID(s): {self.horse_class_ids}")

        # 3. ByteTrack Tracker tuned for horses (large quadrupeds with deliberate motion)
        activation_thresh = float(self.rules.get("track_activation_thresh", 0.25))
        lost_buffer = int(self.rules.get("lost_track_buffer", 60))
        matching_thresh = float(self.rules.get("matching_thresh", 0.70))
        frame_rate = int(self.rules.get("frame_rate", 15))

        self.tracker = sv.ByteTrack(
            track_activation_threshold=activation_thresh,
            lost_track_buffer=lost_buffer,
            minimum_matching_threshold=matching_thresh,
            frame_rate=frame_rate
        )

        # Trajectory smoother to eliminate bounding box jitter
        smoothing_frames = int(self.rules.get("smoothing_frames", 4))
        self.smoother = sv.DetectionsSmoother(length=smoothing_frames)

        # 4. Supervision Annotators
        # Horse tracking theme: Emerald green / Teal palette
        self.box_color = sv.Color(r=0, g=230, b=118)
        self.box_annotator = sv.BoxAnnotator(
            color=self.box_color,
            thickness=3
        )
        self.label_annotator = sv.LabelAnnotator(
            color=self.box_color,
            text_color=sv.Color(r=10, g=20, b=15),
            text_scale=0.65,
            text_thickness=2,
            text_position=sv.Position.TOP_LEFT
        )
        
        trace_length = int(self.rules.get("trace_length", 45))
        self.trace_annotator = sv.TraceAnnotator(
            color=self.box_color,
            thickness=3,
            trace_length=trace_length,
            position=sv.Position.BOTTOM_CENTER
        )

        # Display flags (can be toggled for clean client demos)
        self.show_boxes = bool(self.rules.get("show_boxes", True))
        self.show_labels = bool(self.rules.get("show_labels", True))
        self.show_traces = bool(self.rules.get("show_traces", True))

        # 5. Virtual Tripwire & ROI zones
        self.tripwire_enabled = False
        tripwire_cfg = self.rules.get("tripwire", {})
        if isinstance(tripwire_cfg, dict) and tripwire_cfg.get("enabled", False):
            self.tripwire_enabled = True

        self.line_zone: Optional[sv.LineZone] = None
        self.line_zone_annotator: Optional[sv.LineZoneAnnotator] = None
        self.roi_zone: Optional[sv.PolygonZone] = None
        self.roi_pts: Optional[np.ndarray] = None

        # 6. Tracking Statistics & State
        self.active_horse_count: int = 0
        self.total_unique_horses: set = set()
        self.last_seen_times: Dict[int, float] = {}
        self.horse_positions: Dict[int, Tuple[int, int]] = {}
        self.recent_departures: List[Dict[str, Any]] = []

        # Nx Event debouncing
        self.last_alert_time: float = 0.0
        self.debounce_alert_sec = float(self.rules.get("debounce_alert_sec", 15.0))
        self.nx_bookmark_cfg = self.rules.get("nx_bookmark", {})

    def _init_zones_if_needed(self, frame_shape: Tuple[int, int, int]):
        """Initializes tripwire LineZone and ROI PolygonZone lazily on first frame."""
        h, w = frame_shape[:2]

        # Initialize Tripwire if enabled
        if self.tripwire_enabled and self.line_zone is None:
            raw_start = self.rules.get("tripwire", {}).get("start", [0.20, 0.60])
            raw_end = self.rules.get("tripwire", {}).get("end", [0.80, 0.60])
            self.set_tripwire(raw_start, raw_end, frame_shape)
            self.line_zone_annotator = sv.LineZoneAnnotator(
                thickness=3,
                text_thickness=2,
                text_scale=0.75,
                color=sv.Color(r=255, g=170, b=0),
                custom_in_text="DEPARTURE",
                custom_out_text="RETURN"
            )

        # Initialize ROI Polygon if provided
        if self.roi_zone is None:
            raw_roi = self.rules.get("roi_polygon")
            if raw_roi and len(raw_roi) >= 3:
                self.roi_pts = np.array(
                    [[int(p[0] * w), int(p[1] * h)] for p in raw_roi],
                    dtype=np.int32
                )
                self.roi_zone = sv.PolygonZone(
                    polygon=self.roi_pts,
                    triggering_anchors=[sv.Position.BOTTOM_CENTER, sv.Position.CENTER]
                )
                logger.info(f"[{self.camera_name}] Activated ROI filter polygon with {len(raw_roi)} points.")

    def set_tripwire(self, start_norm: List[float], end_norm: List[float], frame_shape: Tuple[int, ...]):
        """Dynamically update tripwire coordinates (useful with interactive coordinate picker)."""
        h, w = frame_shape[:2]
        start_pt = sv.Point(x=int(start_norm[0] * w), y=int(start_norm[1] * h))
        end_pt = sv.Point(x=int(end_norm[0] * w), y=int(end_norm[1] * h))

        # Preserve previous counts if available
        old_in = self.line_zone._in_count_per_class.copy() if self.line_zone else None
        old_out = self.line_zone._out_count_per_class.copy() if self.line_zone else None

        self.line_zone = sv.LineZone(
            start=start_pt,
            end=end_pt,
            triggering_anchors=[sv.Position.BOTTOM_CENTER]
        )
        if old_in is not None:
            self.line_zone._in_count_per_class = old_in
        if old_out is not None:
            self.line_zone._out_count_per_class = old_out
        self.tripwire_enabled = True

        if self.line_zone_annotator is None:
            self.line_zone_annotator = sv.LineZoneAnnotator(
                thickness=3,
                text_thickness=2,
                text_scale=0.75,
                color=sv.Color(r=255, g=170, b=0),
                custom_in_text="DEPARTURE",
                custom_out_text="RETURN"
            )

        logger.info(f"[{self.camera_name}] Horse Tripwire updated: ({start_pt.x}, {start_pt.y}) -> ({end_pt.x}, {end_pt.y})")

    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        """
        Process a single decoded video frame:
        1. Run YOLO detection filtering exclusively for horses.
        2. Filter by ROI if configured.
        3. Track with ByteTrack & smooth trajectories.
        4. Trigger tripwire line-crossing for ride counting if enabled.
        5. Render high-contrast executive HUD and overlays.
        """
        self._init_zones_if_needed(frame.shape)
        now_sec = timestamp_ms / 1000.0 if timestamp_ms > 0 else time.time()

        # 1. Run YOLO inference
        results = self.model(
            frame,
            classes=self.horse_class_ids,
            conf=self.conf_thresh,
            imgsz=self.imgsz,
            verbose=False,
            device=self.device
        )[0]
        detections = sv.Detections.from_ultralytics(results)

        # 2. Filter detections within ROI if active
        if self.roi_zone is not None and len(detections) > 0:
            roi_mask = self.roi_zone.trigger(detections=detections)
            detections = detections[roi_mask]

        # 3. Track with ByteTrack and smooth trajectory
        detections = self.tracker.update_with_detections(detections)
        if len(detections) > 0:
            detections = self.smoother.update_with_detections(detections)

        # Update tracking stats
        self.active_horse_count = len(detections)
        if detections.tracker_id is not None and len(detections) > 0:
            for tid, box in zip(detections.tracker_id, detections.xyxy):
                if tid is not None:
                    self.total_unique_horses.add(int(tid))
                    self.last_seen_times[int(tid)] = now_sec
                    center_x = int((box[0] + box[2]) / 2)
                    center_y = int(box[3]) # bottom center
                    self.horse_positions[int(tid)] = (center_x, center_y)

        # 4. Handle Tripwire / Choke Point Line Crossing if enabled
        if self.tripwire_enabled and self.line_zone is not None:
            crossed_in, crossed_out = self.line_zone.trigger(detections=detections)
            if np.any(crossed_in) or np.any(crossed_out):
                for i in range(len(detections)):
                    is_in = crossed_in[i] if i < len(crossed_in) else False
                    is_out = crossed_out[i] if i < len(crossed_out) else False
                    if is_in or is_out:
                        tid = detections.tracker_id[i] if detections.tracker_id is not None else "N/A"
                        direction = "DEPARTURE" if is_in else "RETURN"
                        self._on_horse_crossed(tid, direction, timestamp_ms)

        # 5. Render Visualizations
        annotated_frame = frame.copy()

        # Draw ROI polygon if defined
        if self.roi_pts is not None:
            cv2.polylines(annotated_frame, [self.roi_pts], isClosed=True, color=(100, 255, 100), thickness=2)

        # Draw Tripwire
        if self.tripwire_enabled and self.line_zone is not None and self.line_zone_annotator is not None:
            annotated_frame = self.line_zone_annotator.annotate(annotated_frame, line_counter=self.line_zone)

        # Draw Trajectory Traces (motion trails)
        if self.show_traces and len(detections) > 0:
            annotated_frame = self.trace_annotator.annotate(annotated_frame, detections=detections)

        # Draw Bounding Boxes and Labels
        if self.show_boxes and len(detections) > 0:
            annotated_frame = self.box_annotator.annotate(annotated_frame, detections=detections)
            if self.show_labels:
                if detections.tracker_id is not None:
                    labels = [
                        f"Horse #{tid} ({conf:.0%})" if tid is not None else f"Horse ({conf:.0%})"
                        for tid, conf in zip(detections.tracker_id, detections.confidence)
                    ]
                else:
                    labels = [f"Horse ({conf:.0%})" for conf in detections.confidence]
                annotated_frame = self.label_annotator.annotate(annotated_frame, detections=detections, labels=labels)

        # 6. Render Executive Glassmorphic HUD
        annotated_frame = self._render_executive_hud(annotated_frame)

        return annotated_frame

    def _on_horse_crossed(self, tracker_id: Any, direction: str, timestamp_ms: int):
        """Dispatches an audit bookmark to Nx Meta when a horse crosses the departure line."""
        now = time.time()
        desc = f"Horse #{tracker_id} {direction} recorded at {self.camera_name}."
        logger.info(f"[{self.camera_name}] [CHOKE CROSSING] {desc}")

        self.recent_departures.append({
            "tracker_id": tracker_id,
            "direction": direction,
            "time_ms": timestamp_ms
        })
        if len(self.recent_departures) > 10:
            self.recent_departures.pop(0)

        # Debounce alerts sent to Nx Meta
        if self.nx_client and (now - self.last_alert_time >= self.debounce_alert_sec):
            self.last_alert_time = now
            tag = self.nx_bookmark_cfg.get("tag", "#horse_audit")
            title = f"[RIDE AUDIT] Horse #{tracker_id} {direction}"
            self.nx_client.create_bookmark(
                camera_id=self.nx_camera_id,
                title=title,
                description=desc,
                tags=[tag, "#riding_attraction"],
                start_time_ms=timestamp_ms,
                duration_ms=10000
            )

    def _render_executive_hud(self, frame: np.ndarray) -> np.ndarray:
        """
        Renders an ultra-clean, executive presentation HUD panel on the upper-left
        displaying active horse tracking metrics, departure stats, and live status.
        """
        h, w = frame.shape[:2]

        card_w = 480
        card_h = 115 if self.tripwire_enabled else 95
        card_x = 20
        card_y = 20

        # Semi-transparent dark glass background
        sub_img = frame[card_y:card_y + card_h, card_x:card_x + card_w]
        dark_overlay = np.full(sub_img.shape, 18, dtype=np.uint8)
        frame[card_y:card_y + card_h, card_x:card_x + card_w] = cv2.addWeighted(
            sub_img, 0.25, dark_overlay, 0.75, 0
        )

        # Elegant border stroke
        cv2.rectangle(
            frame,
            (card_x, card_y),
            (card_x + card_w, card_y + card_h),
            (0, 230, 118),
            2
        )

        # Header Title: Attraction Name & Pipeline Tag
        cv2.putText(
            frame,
            f"HORSE RIDING ATTRACTION",
            (card_x + 15, card_y + 26),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.62,
            (255, 255, 255),
            2
        )

        # Live Status Badge (Upper Right of Card)
        if self.active_horse_count > 0:
            badge_text = "TRACKING ACTIVE"
            badge_color = (0, 230, 118) # Emerald Green
        else:
            badge_text = "STANDBY / CLEAR"
            badge_color = (180, 180, 180) # Gray

        cv2.putText(
            frame,
            f"[{badge_text}]",
            (card_x + 285, card_y + 26),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.50,
            badge_color,
            2
        )

        # Primary Metric: Active Horses currently in view
        active_color = (0, 255, 200) if self.active_horse_count > 0 else (200, 200, 200)
        cv2.putText(
            frame,
            f"ACTIVE HORSES IN VIEW:  {self.active_horse_count}",
            (card_x + 15, card_y + 56),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.72,
            active_color,
            2
        )

        # Secondary Metric: Unique horses tracked & model info
        total_unique = len(self.total_unique_horses)
        cv2.putText(
            frame,
            f"CUMULATIVE DETECTED: {total_unique}   |   MODEL: YOLO11 + ByteTrack",
            (card_x + 15, card_y + 80),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.44,
            (200, 200, 200),
            1
        )

        # Optional Tertiary Metric: Tripwire Departures & Returns
        if self.tripwire_enabled and self.line_zone is not None:
            dep_str = f"RIDE DEPARTURES: {self.line_zone.in_count}   |   RETURNS: {self.line_zone.out_count}"
            cv2.putText(
                frame,
                dep_str,
                (card_x + 15, card_y + 104),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                (255, 170, 0),
                2
            )

        return frame
