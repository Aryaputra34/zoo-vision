"""
Table Occupancy & Dwell Time Monitoring Engine.
Modular component for tracking dining table occupancy, vacancy, dwell times, and turn rates.
Can be used standalone in TableOccupancyPipeline or embedded in RestaurantCounterPipeline.
"""

import time
import logging
from typing import List, Dict, Any, Optional, Tuple, Callable
import cv2
import numpy as np
import supervision as sv

logger = logging.getLogger("TableManager")


class TableZone:
    """Represents a single dining table ROI and its occupancy state machine."""

    def __init__(
        self,
        table_id: str,
        name: str,
        normalized_polygon: List[List[float]],
        capacity: int = 4,
        confidence_threshold: Optional[float] = None,
        min_occupied_sec: float = 0.0,
        empty_debounce_sec: float = 15.0,
        track_dwell_time: bool = True
    ):
        self.table_id = str(table_id)
        self.name = name or f"Table {table_id}"
        self.raw_polygon = normalized_polygon
        self.capacity = capacity
        self.confidence_threshold = confidence_threshold
        self.min_occupied_sec = float(min_occupied_sec)
        self.empty_debounce_sec = float(empty_debounce_sec)
        self.track_dwell_time = bool(track_dwell_time)

        # Pixel polygon cache
        self.cached_frame_shape: Optional[Tuple[int, int]] = None
        self.pixel_polygon: Optional[np.ndarray] = None
        self.center_pt: Tuple[int, int] = (0, 0)
        self.bbox: Tuple[int, int, int, int] = (0, 0, 0, 0)

        # Operational State
        self.status: str = "EMPTY"  # "EMPTY" or "OCCUPIED"
        self.raw_person_count: int = 0
        self.candidate_person_count: int = 0

        # Temporal Hysteresis & Dwell Timestamps (in seconds)
        self.first_detected_occupied_time: Optional[float] = None
        self.last_detected_occupied_time: Optional[float] = None
        self.occupied_start_time: Optional[float] = None
        self.current_dwell_sec: int = 0
        self.total_sessions_count: int = 0

    def init_pixel_polygon(self, frame_shape: Tuple[int, int]):
        """Scales normalized polygon to the current frame resolution."""
        if self.pixel_polygon is not None and self.cached_frame_shape == frame_shape[:2]:
            return

        h, w = frame_shape[:2]
        pts = [[int(pt[0] * w), int(pt[1] * h)] for pt in self.raw_polygon]
        self.pixel_polygon = np.array(pts, dtype=np.int32)
        self.cached_frame_shape = frame_shape[:2]

        # Calculate center point for badge anchoring
        moments = cv2.moments(self.pixel_polygon)
        if moments["m00"] != 0:
            cx = int(moments["m10"] / moments["m00"])
            cy = int(moments["m01"] / moments["m00"])
        else:
            cx = int(np.mean(self.pixel_polygon[:, 0]))
            cy = int(np.mean(self.pixel_polygon[:, 1]))
        self.center_pt = (cx, cy)

        # Bounding box of the table polygon
        x, y, bw, bh = cv2.boundingRect(self.pixel_polygon)
        self.bbox = (x, y, x + bw, y + bh)

    def contains_point(self, pt: Tuple[float, float]) -> bool:
        """Tests if a coordinate falls inside the table polygon."""
        if self.pixel_polygon is None:
            return False
        return cv2.pointPolygonTest(self.pixel_polygon, (float(pt[0]), float(pt[1])), False) >= 0

    def test_detection(self, xyxy: np.ndarray, conf: float, default_conf: float) -> Tuple[bool, float]:
        """
        Determines if a person bounding box belongs to this table:
        Tests center, torso, head/shoulders, and bottom center against the table polygon.
        Returns (is_match: bool, penetration_depth: float).
        """
        req_conf = self.confidence_threshold if self.confidence_threshold is not None else default_conf
        if conf < req_conf or self.pixel_polygon is None:
            return False, -1.0

        x1, y1, x2, y2 = xyxy
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        head_y = y1 + 0.30 * (y2 - y1)
        torso_y = y1 + 0.60 * (y2 - y1)
        bottom_y = y2

        # 1. Anchors inside polygon
        d_torso = cv2.pointPolygonTest(self.pixel_polygon, (float(cx), float(torso_y)), True)
        d_center = cv2.pointPolygonTest(self.pixel_polygon, (float(cx), float(cy)), True)
        d_head = cv2.pointPolygonTest(self.pixel_polygon, (float(cx), float(head_y)), True)
        d_bottom = cv2.pointPolygonTest(self.pixel_polygon, (float(cx), float(bottom_y)), True)

        depth = max(d_torso, d_center, d_head, d_bottom)
        if depth >= 0:
            return True, depth

        # 2. Overlap test: If person bounding box intersects table polygon bounding box,
        # test if either lateral torso point falls inside polygon
        bx1, by1, bx2, by2 = self.bbox
        if max(x1, bx1) < min(x2, bx2) and max(y1, by1) < min(y2, by2):
            d_l = cv2.pointPolygonTest(self.pixel_polygon, (float(x1), float(torso_y)), True)
            d_r = cv2.pointPolygonTest(self.pixel_polygon, (float(x2), float(torso_y)), True)
            lat_depth = max(d_l, d_r)
            if lat_depth >= 0:
                return True, lat_depth

        return False, -1.0

    def update_state(
        self,
        persons_in_zone: int,
        now_sec: float
    ) -> Optional[Tuple[str, str, int]]:
        """
        Updates table state machine with debounce and dwell-time tracking.
        Returns (old_status, new_status, dwell_sec) if a transition occurred, else None.
        """
        self.raw_person_count = persons_in_zone
        transition = None

        if persons_in_zone > 0:
            self.last_detected_occupied_time = now_sec

            if self.status == "EMPTY":
                # Candidate occupied: start timing presence
                if self.first_detected_occupied_time is None:
                    self.first_detected_occupied_time = now_sec

                elapsed_presence = now_sec - self.first_detected_occupied_time
                if elapsed_presence >= self.min_occupied_sec or self.min_occupied_sec <= 0.0:
                    # Confirmed transition EMPTY -> OCCUPIED
                    old_status = self.status
                    self.status = "OCCUPIED"
                    self.occupied_start_time = now_sec
                    self.current_dwell_sec = 0
                    self.total_sessions_count += 1
                    transition = (old_status, self.status, 0)
                    logger.info(f"[{self.name}] Transitioned: EMPTY -> OCCUPIED (persons={persons_in_zone})")
            else:
                # Already OCCUPIED: update dwell duration
                if self.occupied_start_time is not None and self.track_dwell_time:
                    self.current_dwell_sec = max(0, int(now_sec - self.occupied_start_time))
                else:
                    self.current_dwell_sec = 0

        else:
            # Zero persons detected in current frame
            # Only reset candidate timer if absent for > 2.0s to tolerate momentary detector drops
            if self.last_detected_occupied_time and (now_sec - self.last_detected_occupied_time) > 2.0:
                self.first_detected_occupied_time = None

            if self.status == "OCCUPIED":
                # Check empty debounce grace period
                idle_sec = (now_sec - self.last_detected_occupied_time) if self.last_detected_occupied_time else 0.0

                if idle_sec >= self.empty_debounce_sec:
                    # Confirmed transition OCCUPIED -> EMPTY
                    old_status = self.status
                    self.status = "EMPTY"
                    final_dwell = self.current_dwell_sec
                    self.occupied_start_time = None
                    self.current_dwell_sec = 0
                    transition = (old_status, self.status, final_dwell)
                    logger.info(f"[{self.name}] Transitioned: OCCUPIED -> EMPTY (final dwell: {final_dwell}s)")
                else:
                    # Still in debounce grace period: maintain OCCUPIED and dwell timer
                    if self.occupied_start_time is not None and self.track_dwell_time:
                        self.current_dwell_sec = max(0, int(now_sec - self.occupied_start_time))

        return transition

    def get_dict(self) -> Dict[str, Any]:
        """Returns structured JSON-serializable status payload."""
        return {
            "id": self.table_id,
            "name": self.name,
            "status": self.status,
            "isOccupied": (self.status == "OCCUPIED"),
            "personCount": self.raw_person_count,
            "capacity": self.capacity,
            "dwellSec": self.current_dwell_sec if self.track_dwell_time else 0,
            "trackDwellTime": self.track_dwell_time,
            "totalSessions": self.total_sessions_count,
        }


class TableOccupancyEngine:
    """
    Core engine managing all dining tables, spatial checking,
    debouncing, and visual HUD overlays.
    """

    def __init__(
        self,
        config: Dict[str, Any],
        on_event_callback: Optional[Callable[[str, Dict[str, Any], str], None]] = None
    ):
        self.config = config or {}
        self.enabled = bool(self.config.get("enabled", True))
        self.on_event = on_event_callback

        # Global Dwell Time & Hysteresis Defaults
        dwell_cfg = self.config.get("dwell_time", {})
        self.track_dwell_time = bool(dwell_cfg.get("enabled", False))
        self.min_occupied_sec = float(dwell_cfg.get("min_occupied_sec", 0.0))
        self.empty_debounce_sec = float(dwell_cfg.get("empty_debounce_sec", 15.0))
        self.alert_dwell_sec = float(dwell_cfg.get("alert_dwell_sec", 3600.0))

        # Presentation Settings
        self.show_overlay = bool(self.config.get("show_overlay", True))
        self.show_labels = bool(self.config.get("show_labels", True))
        self.show_summary_card = bool(self.config.get("show_summary_card", False))

        # Build Table Zones
        self.tables: List[TableZone] = []
        raw_tables = self.config.get("tables", [])
        for t_cfg in raw_tables:
            poly = t_cfg.get("polygon")
            if not poly or len(poly) < 3:
                continue

            t_zone = TableZone(
                table_id=t_cfg.get("id", f"T{len(self.tables) + 1}"),
                name=t_cfg.get("name", ""),
                normalized_polygon=poly,
                capacity=int(t_cfg.get("capacity", 4)),
                confidence_threshold=t_cfg.get("confidence_threshold"),
                min_occupied_sec=t_cfg.get("min_occupied_sec", self.min_occupied_sec),
                empty_debounce_sec=t_cfg.get("empty_debounce_sec", self.empty_debounce_sec),
                track_dwell_time=t_cfg.get("track_dwell_time", self.track_dwell_time),
            )
            self.tables.append(t_zone)

        logger.info(
            f"Initialized TableOccupancyEngine: {len(self.tables)} tables configured. "
            f"(track_dwell_time={self.track_dwell_time}, min_occupied={self.min_occupied_sec}s, "
            f"empty_debounce={self.empty_debounce_sec}s)"
        )

    def set_dwell_time_enabled(self, enabled: bool):
        """Dynamic runtime toggle for dwell time tracking."""
        self.track_dwell_time = bool(enabled)
        for t in self.tables:
            t.track_dwell_time = self.track_dwell_time
        logger.info(f"TableOccupancyEngine dwell time tracking toggled to: {self.track_dwell_time}")

    def update(
        self,
        detections: sv.Detections,
        timestamp_ms: int,
        frame_shape: Tuple[int, int],
        default_conf: float = 0.20
    ) -> Dict[str, Any]:
        """
        Updates all tables with the current detections.
        Returns full table occupancy summary.
        """
        if not self.enabled or not self.tables:
            return {"totalTables": 0, "occupiedTables": 0, "vacantTables": 0, "tables": []}

        now_sec = (timestamp_ms / 1000.0) if timestamp_ms > 0 else time.time()

        # 1. Initialize pixel polygons for current resolution
        for t in self.tables:
            t.init_pixel_polygon(frame_shape)

        # 2. Count persons per table
        has_dets = len(detections) > 0 and detections.xyxy is not None
        boxes = detections.xyxy if has_dets else []
        confs = detections.confidence if (has_dets and detections.confidence is not None) else np.ones(len(boxes))

        table_counts = {t.table_id: 0 for t in self.tables}
        if has_dets:
            for xyxy, conf in zip(boxes, confs):
                best_table_id = None
                best_depth = -1.0
                for t in self.tables:
                    matched, depth = t.test_detection(xyxy, float(conf), default_conf)
                    if matched and depth > best_depth:
                        best_depth = depth
                        best_table_id = t.table_id
                if best_table_id is not None:
                    table_counts[best_table_id] += 1

        # 3. Update state machine and dispatch events
        occupied_count = 0
        for t in self.tables:
            transition = t.update_state(table_counts[t.table_id], now_sec)
            if t.status == "OCCUPIED":
                occupied_count += 1

            if transition and self.on_event:
                old_status, new_status, dwell_sec = transition
                self.on_event(
                    "table_state_change",
                    {
                        "tableId": t.table_id,
                        "tableName": t.name,
                        "oldStatus": old_status,
                        "status": new_status,
                        "dwellSec": dwell_sec,
                        "timestampMs": timestamp_ms,
                    },
                    "info"
                )

        total_tables = len(self.tables)
        vacant_count = total_tables - occupied_count
        occ_pct = round((occupied_count / max(1, total_tables)) * 100, 1)

        return {
            "totalTables": total_tables,
            "occupiedTables": occupied_count,
            "vacantTables": vacant_count,
            "occupancyRatePct": occ_pct,
            "dwellTimeEnabled": self.track_dwell_time,
            "tables": [t.get_dict() for t in self.tables]
        }

    def annotate(self, frame: np.ndarray) -> np.ndarray:
        """
        Draws premium visual overlays for tables:
        - Polygons with distinct colors for EMPTY (green) and OCCUPIED (cyan/coral).
        - Badges displaying Table Name, Status, and optional Dwell Timer.
        """
        if not self.enabled or not self.show_overlay or not self.tables:
            return frame

        overlay = frame.copy()

        for t in self.tables:
            if t.pixel_polygon is None:
                continue

            is_occ = (t.status == "OCCUPIED")
            # Occupied = Amber/Cyan (#00C5FF), Empty = Emerald Green (#00E676)
            fill_color = (0, 165, 255) if is_occ else (0, 200, 100)
            border_color = (0, 215, 255) if is_occ else (0, 255, 120)

            # Translucent zone fill
            cv2.fillPoly(overlay, [t.pixel_polygon], fill_color)

            # Solid border
            cv2.polylines(frame, [t.pixel_polygon], isClosed=True, color=border_color, thickness=2, lineType=cv2.LINE_AA)

            # Badge / Label
            if self.show_labels:
                self._draw_table_badge(frame, t, is_occ)

        # Blend translucent fill (25% opacity)
        alpha = 0.22
        frame = cv2.addWeighted(overlay, alpha, frame, 1.0 - alpha, 0)

        # Optional standalone summary HUD card
        if self.show_summary_card:
            frame = self._draw_summary_hud(frame)

        return frame

    def _draw_table_badge(self, frame: np.ndarray, table: TableZone, is_occupied: bool):
        """Draws an anti-aliased badge for a table with status and optional dwell timer."""
        cx, cy = table.center_pt

        # Build text string
        if is_occupied:
            if self.track_dwell_time and table.current_dwell_sec > 0:
                mins = table.current_dwell_sec // 60
                secs = table.current_dwell_sec % 60
                dwell_str = f"{mins}m {secs:02d}s" if mins > 0 else f"{secs}s"
                text = f"{table.name}: OCCUPIED ({dwell_str})"
            else:
                text = f"{table.name}: OCCUPIED"
            bg_color = (15, 100, 200) # Warm amber/brown
            text_color = (255, 255, 255)
        else:
            text = f"{table.name}: VACANT"
            bg_color = (20, 100, 30) # Dark forest green
            text_color = (220, 255, 220)

        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = 0.45
        thick = 1
        (tw, th), baseline = cv2.getTextSize(text, font, scale, thick)

        # Position badge centered over table center
        bx = max(10, cx - tw // 2 - 6)
        by = max(th + 10, cy - th // 2 - 4)
        bw = tw + 12
        bh = th + 8

        # Draw rounded/filled rectangle background
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (30, 30, 30), -1)
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), bg_color, 1, cv2.LINE_AA)
        cv2.putText(frame, text, (bx + 6, by + bh - 6), font, scale, text_color, thick, cv2.LINE_AA)

    def _draw_summary_hud(self, frame: np.ndarray) -> np.ndarray:
        """Renders an attractive summary widget at top-right of frame."""
        h, w = frame.shape[:2]
        occupied = sum(1 for t in self.tables if t.status == "OCCUPIED")
        total = len(self.tables)
        vacant = total - occupied

        card_w = 260
        card_h = 75
        x1 = w - card_w - 20
        y1 = 20

        # Semi-transparent background
        sub = frame[y1:y1 + card_h, x1:x1 + card_w]
        dark = np.full(sub.shape, 25, dtype=np.uint8)
        frame[y1:y1 + card_h, x1:x1 + card_w] = cv2.addWeighted(sub, 0.35, dark, 0.65, 0)
        cv2.rectangle(frame, (x1, y1), (x1 + card_w, y1 + card_h), (80, 80, 80), 1, cv2.LINE_AA)

        # Text
        cv2.putText(frame, "TABLE OCCUPANCY", (x1 + 14, y1 + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (255, 255, 255), 1, cv2.LINE_AA)
        status_color = (0, 215, 255) if occupied > 0 else (0, 255, 120)
        cv2.putText(frame, f"{occupied}/{total} OCCUPIED ({vacant} FREE)", (x1 + 14, y1 + 52), cv2.FONT_HERSHEY_SIMPLEX, 0.60, status_color, 2, cv2.LINE_AA)

        return frame
