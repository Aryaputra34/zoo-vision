"""
Standalone Table Occupancy & Dwell Time Vision Pipeline.
Monitors individual restaurant tables, booths, and outdoor seating using dedicated overhead or angled cameras.
Provides real-time table status (VACANT / OCCUPIED), dwell duration, and turnaround analytics.
"""

import time
import logging
from typing import Optional, Any, Dict, List, Tuple
import yaml
import cv2
import numpy as np
import supervision as sv

from core.base_pipeline import BasePipeline
from core.table_manager import TableOccupancyEngine
from nx_integration.nx_client import NxClient

logger = logging.getLogger("TableOccupancyPipeline")


class TableOccupancyPipeline(BasePipeline):
    use_case = "restaurant_table"

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

        self.imgsz = self.rules.get("imgsz", 1920)
        self.conf_thresh = float(self.rules.get("confidence_threshold", 0.20))
        self.deduplication_enabled = bool(self.rules.get("deduplication_enabled", True))
        self.iou_threshold = float(self.rules.get("iou_threshold", 0.45))
        self.containment_threshold = float(self.rules.get("containment_threshold", 0.65))

        # Visual settings
        self.show_boxes = bool(self.rules.get("show_person_boxes", False))
        self.show_labels = bool(self.rules.get("show_person_labels", False))
        self.box_annotator = sv.BoxAnnotator(thickness=1)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)

        # Initialize Table Occupancy Engine
        table_cfg = self.rules.get("table_monitoring", self.rules)
        # If the root config contains 'tables', pass the whole dictionary
        if "tables" in self.rules and "tables" not in table_cfg:
            table_cfg["tables"] = self.rules["tables"]

        # Ensure summary HUD card is rendered for standalone table camera
        if "show_summary_card" not in table_cfg:
            table_cfg["show_summary_card"] = True

        self.table_engine = TableOccupancyEngine(
            config=table_cfg,
            on_event_callback=self._handle_table_event
        )

        # Heartbeat caching
        self.last_summary: Dict[str, Any] = {}

        logger.info(
            f"[{self.camera_name}] Initialized Standalone Table Occupancy Pipeline with model '{model_name}' "
            f"({len(self.table_engine.tables)} tables active, dwell_tracking={self.table_engine.track_dwell_time})."
        )

    def _suppress_duplicates(self, detections: sv.Detections) -> sv.Detections:
        """Suppresses duplicate and nested person detections."""
        if not self.deduplication_enabled or len(detections) <= 1:
            return detections

        dets = detections.with_nms(threshold=self.iou_threshold)
        if len(dets) <= 1:
            return dets

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

    def _handle_table_event(self, event_type: str, data: Dict[str, Any], severity: str):
        """Dispatches table events to Web Analytics Dashboard and Nx Meta Bookmarks."""
        # 1. Forward to web dashboard
        self.emit(event_type, data, severity)

        # 2. Bookmark significant table state transitions in Nx Meta VMS
        if self.nx_client and event_type == "table_state_change":
            tbl_name = data.get("tableName", data.get("tableId", "Table"))
            status = data.get("status", "")
            dwell_sec = data.get("dwellSec", 0)

            if status == "OCCUPIED":
                title = f"[TABLE] {tbl_name} Seated"
                desc = f"Guests seated at {tbl_name} ({self.camera_name})."
                tags = ["#restaurant_tables", "#table_seated"]
            else:
                mins = dwell_sec // 60
                title = f"[TABLE] {tbl_name} Vacated"
                desc = f"{tbl_name} vacated after {mins}m dwell time ({self.camera_name})."
                tags = ["#restaurant_tables", "#table_vacated"]

            ts_ms = data.get("timestampMs") or int(time.time() * 1000)
            self.nx_client.create_bookmark(
                camera_id=self.nx_camera_id,
                title=title,
                description=desc,
                tags=tags,
                start_time_ms=ts_ms,
                duration_ms=5000
            )

    def process_frame(self, frame: np.ndarray, timestamp_ms: int) -> np.ndarray:
        # 1. Run inference
        results = self.model(
            frame,
            classes=[0],
            conf=self.conf_thresh,
            imgsz=self.imgsz,
            verbose=False,
            device=self.device
        )[0]
        detections = sv.Detections.from_ultralytics(results)
        detections = self._suppress_duplicates(detections)

        # 2. Update table occupancy engine
        summary = self.table_engine.update(
            detections=detections,
            timestamp_ms=timestamp_ms,
            frame_shape=frame.shape,
            default_conf=self.conf_thresh
        )
        self.last_summary = summary

        # 3. Emit heartbeat telemetry
        self.emit_status({
            "totalTables": summary.get("totalTables", 0),
            "occupiedTables": summary.get("occupiedTables", 0),
            "vacantTables": summary.get("vacantTables", 0),
            "occupancyRatePct": summary.get("occupancyRatePct", 0.0),
            "dwellTimeEnabled": summary.get("dwellTimeEnabled", False),
            "tables": summary.get("tables", []),
        })

        # 4. Render visualizations
        annotated = frame.copy()
        if self.show_boxes and len(detections) > 0:
            annotated = self.box_annotator.annotate(annotated, detections=detections)
            if self.show_labels:
                labels = [f"person {c:.2f}" for c in detections.confidence]
                annotated = self.label_annotator.annotate(annotated, detections=detections, labels=labels)

        # Draw table polygons, badges, and summary card
        annotated = self.table_engine.annotate(annotated)
        return annotated
