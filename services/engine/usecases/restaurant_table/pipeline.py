"""
Standalone Table Occupancy & Dwell Time Vision Pipeline.
Monitors individual restaurant tables, booths, and outdoor seating using dedicated overhead or angled cameras.
Provides real-time table status (VACANT / OCCUPIED), dwell duration, and turnaround analytics.
"""

import time
import logging
from typing import Any, Dict
import cv2
import numpy as np
import supervision as sv

from contracts.restaurant_table.settings import RestaurantTableSettings
from core.base_pipeline import BasePipeline, CameraInfo
from core.model_pool import Detector
from core.table_manager import TableOccupancyEngine, TableSessions

logger = logging.getLogger("TableOccupancyPipeline")


class TableOccupancyPipeline(BasePipeline):
    use_case = "restaurant_table"
    metric_fields = {"occupiedTables": "occupied_tables", "occupancyRatePct": "table_occupancy_pct"}

    settings: RestaurantTableSettings

    def __init__(self, camera: CameraInfo, settings: RestaurantTableSettings, model: Detector, **kwargs):
        super().__init__(camera, settings, model, **kwargs)

        self._read_scalars()
        self.box_annotator = sv.BoxAnnotator(thickness=1)
        self.label_annotator = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)

        # Initialize Table Occupancy Engine. It takes a plain dict; unset (None) options fall back to its defaults.
        self.table_sessions = TableSessions(self)
        self.table_engine = TableOccupancyEngine(
            config=self._table_config(),
            on_event_callback=self._handle_table_event
        )

        # Heartbeat caching
        self.last_summary: Dict[str, Any] = {}

        logger.info(
            f"[{self.camera_name}] Initialized Standalone Table Occupancy Pipeline with model '{settings.model_name}' "
            f"({len(self.table_engine.tables)} tables active, dwell_tracking={self.table_engine.track_dwell_time})."
        )

    def _read_scalars(self):
        s = self.settings
        self.conf_thresh = float(s.confidence_threshold)
        self.deduplication_enabled = bool(s.deduplication_enabled)
        self.iou_threshold = float(s.iou_threshold)
        self.containment_threshold = float(s.containment_threshold)

        # Visual settings
        self.show_boxes = bool(s.show_person_boxes)
        self.show_labels = bool(s.show_person_labels)

    def _table_config(self) -> Dict[str, Any]:
        """The engine takes a plain dict; unset (None) options fall back to its defaults."""
        return self.settings.model_dump(
            include={"show_overlay", "show_labels", "show_summary_card", "dwell_time", "tables"}, exclude_none=True
        )

    def _on_settings(self, old, new):
        self._read_scalars()
        if self.changed(old, new, "tables", "dwell_time", "show_overlay", "show_labels", "show_summary_card"):
            for table_id in self.table_engine.reconfigure(self._table_config()):
                self.table_sessions.close(table_id, "config_change")

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
        """Turns table state changes into table_session intervals and Nx Meta Bookmarks."""
        # 1. Open / close the table session
        if event_type == "table_state_change":
            self.table_sessions.on_change(data)

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
                camera_id=self.nx_id,
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
            imgsz=self.settings.imgsz,
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
