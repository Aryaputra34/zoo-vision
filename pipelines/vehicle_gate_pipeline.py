"""
Vehicle Gate Counting & Audit Pipeline (Phase 1 Quick Win).
Tracks vehicles (cars, motorcycles, buses, trucks) crossing gate tripwires with ByteTrack and logs audit bookmarks.
"""

import time
import logging
from typing import Any, Optional, Dict
import cv2
import numpy as np
import supervision as sv

from core.base_pipeline import BasePipeline
from core.anpr_engine import AnprEngine
from nx_integration.nx_client import NxClient

logger = logging.getLogger("VehicleGatePipeline")

# Standard COCO class IDs for vehicles
VEHICLE_CLASS_IDS = [2, 3, 5, 7] # car, motorcycle, bus, truck
CLASS_NAMES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}


class VehicleGatePipeline(BasePipeline):
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
        model_name = "yolo26s.onnx"
        if rules and "model_name" in rules:
            model_name = rules["model_name"]
        elif rule_config_path:
            try:
                with open(rule_config_path, "r") as f:
                    import yaml
                    cfg = yaml.safe_load(f) or {}
                    model_name = cfg.get("model_name", "yolo26s.onnx")
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

        self.conf_thresh = self.rules.get("confidence_threshold", 0.30)

        # ByteTrack Tracker tuned for vehicle gate / barrier stop-and-go
        self.tracker = sv.ByteTrack(
            track_activation_threshold=self.rules.get("track_activation_thresh", 0.25),
            lost_track_buffer=self.rules.get("lost_track_buffer", 75),  # 5s memory at 15 FPS
            minimum_matching_threshold=self.rules.get("matching_thresh", 0.70),
            frame_rate=self.rules.get("frame_rate", 15)
        )
        self.smoother = sv.DetectionsSmoother(length=4)

        self.box_annotator = sv.BoxAnnotator(thickness=2)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.6, text_thickness=1)
        self.trace_annotator = sv.TraceAnnotator(
            thickness=2,
            trace_length=30,
            position=sv.Position.BOTTOM_CENTER
        )

        # Tripwire LineZone & Roadway ROI
        self.line_zone: Optional[sv.LineZone] = None
        self.line_zone_annotator: Optional[sv.LineZoneAnnotator] = None
        self.roi_zone: Optional[sv.PolygonZone] = None
        self.roi_pts: Optional[np.ndarray] = None

        # Indonesian License Plate Recognition (ANPR / LPR) Engine
        self.anpr_cfg = self.rules.get("anpr", {})
        self.anpr_enabled = bool(self.anpr_cfg.get("enabled", True))
        self.anpr_engine: Optional[AnprEngine] = None
        if self.anpr_enabled:
            plate_model_path = self.anpr_cfg.get("model_path", "models/license_plate_detector.onnx")
            min_plate_conf = float(self.anpr_cfg.get("min_plate_confidence", 0.25))
            try:
                self.anpr_engine = AnprEngine(
                    detector_model_path=plate_model_path,
                    conf_threshold=min_plate_conf,
                    gpu=(device == "cuda")
                )
                logger.info(f"[{self.camera_name}] Indonesian ANPR Engine active (model: {plate_model_path}).")
            except Exception as e:
                logger.error(f"[{self.camera_name}] Failed to initialize ANPR Engine: {e}")
                self.anpr_enabled = False

        # Persistent plate tracking cache: {tracker_id: {"plate_text": ..., "confidence": ..., "is_valid": ...}}
        self.vehicle_plates: Dict[int, Dict[str, Any]] = {}
        self.recent_audits: list = []

    def _init_zones_if_needed(self, frame_shape):
        if self.line_zone is not None:
            return

        h, w = frame_shape[:2]
        raw_start = self.rules.get("tripwire", {}).get("start", [0.760, 0.580])
        raw_end = self.rules.get("tripwire", {}).get("end", [0.050, 0.430])

        self.set_tripwire(raw_start, raw_end, frame_shape)

        self.line_zone_annotator = sv.LineZoneAnnotator(
            thickness=3,
            text_thickness=2,
            text_scale=0.8,
            custom_in_text="ENTRY",
            custom_out_text="EXIT"
        )

        # Initialize Roadway ROI Polygon (filters out building walls, sky, etc.)
        raw_roi = self.rules.get("roi_polygon", None)
        if raw_roi:
            self.roi_pts = np.array([[int(p[0] * w), int(p[1] * h)] for p in raw_roi], dtype=np.int32)
            self.roi_zone = sv.PolygonZone(polygon=self.roi_pts)

    def set_tripwire(self, start_norm, end_norm, frame_shape):
        """Dynamically update tripwire coordinates."""
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

        logger.info(f"[{self.camera_name}] Tripwire set: ({start_pt.x}, {start_pt.y}) -> ({end_pt.x}, {end_pt.y})")

    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        self._init_zones_if_needed(frame.shape)

        # 1. Detect vehicles
        results = self.model(
            frame,
            classes=VEHICLE_CLASS_IDS,
            conf=self.conf_thresh,
            imgsz=self.imgsz,
            verbose=False,
            device=self.device
        )[0]
        detections = sv.Detections.from_ultralytics(results)

        # 2. Filter detections within Roadway ROI (ignoring building walls & background)
        if self.roi_zone is not None and len(detections) > 0:
            roi_mask = self.roi_zone.trigger(detections=detections)
            detections = detections[roi_mask]

        # 3. Track with ByteTrack & Smooth trajectory
        detections = self.tracker.update_with_detections(detections)
        if len(detections) > 0:
            detections = self.smoother.update_with_detections(detections)

        # 4. Perform ANPR on active vehicles in ROI (cache plate text per tracker_id)
        current_plates_to_draw = []
        if self.anpr_engine and detections.tracker_id is not None and len(detections) > 0:
            boxes = detections.xyxy
            tracker_ids = detections.tracker_id
            for tid, box in zip(tracker_ids, boxes):
                if tid is None:
                    continue
                # Only scan if not yet verified or if plate was empty
                cached = self.vehicle_plates.get(tid)
                if cached is None or not cached.get("is_valid", False):
                    v_box = (int(box[0]), int(box[1]), int(box[2]), int(box[3]))
                    # Only attempt if vehicle is sufficiently large (>80px wide)
                    if (v_box[2] - v_box[0]) >= 80 and (v_box[3] - v_box[1]) >= 40:
                        plate_data = self.anpr_engine.process_vehicle(frame, v_box)
                        if plate_data and plate_data.get("plate_text"):
                            # Update if better confidence or valid
                            if cached is None or plate_data.get("is_valid", False) or plate_data.get("ocr_confidence", 0) > cached.get("ocr_confidence", 0):
                                self.vehicle_plates[tid] = plate_data

                # Collect plate boxes to draw
                active_plate = self.vehicle_plates.get(tid)
                if active_plate and active_plate.get("plate_bbox"):
                    current_plates_to_draw.append(active_plate)

        # 5. Line crossing trigger
        crossed_in, crossed_out = self.line_zone.trigger(detections=detections)

        # Handle audit logging for newly crossed vehicles
        if np.any(crossed_in) or np.any(crossed_out):
            for i in range(len(detections)):
                is_in = crossed_in[i] if i < len(crossed_in) else False
                is_out = crossed_out[i] if i < len(crossed_out) else False

                if is_in or is_out:
                    class_id = detections.class_id[i]
                    vehicle_type = CLASS_NAMES.get(class_id, "vehicle")
                    tracker_id = detections.tracker_id[i] if detections.tracker_id is not None else "N/A"
                    direction = "ENTRY" if is_in else "EXIT"

                    # Retrieve recognized plate number from cache
                    plate_info = self.vehicle_plates.get(tracker_id, {})
                    plate_number = plate_info.get("plate_text", "UNIDENTIFIED")

                    self._dispatch_gate_audit(
                        vehicle_type=vehicle_type,
                        direction=direction,
                        tracker_id=tracker_id,
                        plate_number=plate_number,
                        timestamp_ms=timestamp_ms
                    )

        # 6. Annotations
        annotated_frame = frame.copy()
        annotated_frame = self.line_zone_annotator.annotate(annotated_frame, line_counter=self.line_zone)
        annotated_frame = self.trace_annotator.annotate(annotated_frame, detections=detections)
        annotated_frame = self.box_annotator.annotate(annotated_frame, detections=detections)

        # Draw vehicle labels with detected license plate numbers
        labels = []
        if detections.tracker_id is not None:
            for tracker_id, class_id in zip(detections.tracker_id, detections.class_id):
                v_name = CLASS_NAMES.get(class_id, "vehicle")
                plate_info = self.vehicle_plates.get(tracker_id, {})
                plate_txt = plate_info.get("plate_text", "")
                if plate_txt:
                    labels.append(f"#{tracker_id} {v_name} [{plate_txt}]")
                else:
                    labels.append(f"#{tracker_id} {v_name}")
        annotated_frame = self.label_annotator.annotate(annotated_frame, detections=detections, labels=labels)

        # Draw detected license plate bounding boxes & texts
        for p in current_plates_to_draw:
            px1, py1, px2, py2 = p["plate_bbox"]
            txt = p["plate_text"]
            is_val = p.get("is_valid", False)
            box_color = (0, 255, 255) if is_val else (0, 165, 255)
            cv2.rectangle(annotated_frame, (px1, py1), (px2, py2), box_color, 2)
            cv2.putText(annotated_frame, txt, (px1, max(20, py1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, box_color, 2, cv2.LINE_AA)

        # Top banner stats & recent audits
        anpr_status = "ANPR: ACTIVE" if self.anpr_enabled else "ANPR: OFF"
        cv2.putText(annotated_frame, f"{self.camera_name} | {anpr_status}", (20, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        cv2.putText(annotated_frame, f"TOTAL IN: {self.line_zone.in_count} | TOTAL OUT: {self.line_zone.out_count}", (20, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        if self.recent_audits:
            last = self.recent_audits[-1]
            last_text = f"LAST: {last['plate']} ({last['direction']})"
            cv2.putText(annotated_frame, last_text, (20, 105), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

        return annotated_frame

    def _dispatch_gate_audit(self, vehicle_type: str, direction: str, tracker_id: Any, plate_number: str, timestamp_ms: int):
        title = f"[GATE AUDIT] Vehicle {direction} - {vehicle_type.upper()} ({plate_number})"
        description = f"{direction}: {vehicle_type.capitalize()} #{tracker_id} with License Plate [{plate_number}] crossed {self.camera_name}."

        logger.info(f"[{self.camera_name}] {title} - {description}")

        self.recent_audits.append({
            "direction": direction,
            "plate": plate_number,
            "vehicle_type": vehicle_type,
            "timestamp": timestamp_ms
        })
        if len(self.recent_audits) > 10:
            self.recent_audits.pop(0)

        clean_tag = f"#{plate_number.replace(' ', '_').lower()}" if plate_number != "UNIDENTIFIED" else "#unidentified"
        tags = ["#vehicle_audit", f"#{direction.lower()}", f"#{vehicle_type.lower()}", clean_tag]

        self.nx_client.create_bookmark(
            camera_id=self.nx_camera_id,
            title=title,
            description=description,
            tags=tags,
            start_time_ms=timestamp_ms,
            duration_ms=10000
        )
