"""
Interactive Coordinate Picker for Tripwires, Polygons, and Restaurant Tables.

Usage:
    # Tripwire Line Mode (vehicle gates, entry choke points)
    python pick_coordinates.py --video "path/to/video.mp4" --mode line

    # Single Polygon Mode (general ROI or zone)
    python pick_coordinates.py --video "path/to/video.mp4" --mode polygon

    # Restaurant Dining Tables Mode (calibrates all 9 tables interactively)
    python pick_coordinates.py --video "path/to/video.mp4" --mode tables
"""

import os
import sys
import re
import argparse
import cv2
import yaml
import numpy as np
from pathlib import Path

# Rule files edited by this tool (run it from anywhere)
RULES_DIR = Path(__file__).resolve().parent.parent / "services" / "engine" / "configs" / "rules"


class CoordinatePicker:
    def __init__(self, video_path: str, mode: str = "line", update_yaml: str = None):
        self.video_path = video_path
        self.mode = mode.lower()  # "line", "polygon", or "tables"
        self.update_yaml = update_yaml
        self.points = []  # Store raw pixel points [(x, y), ...]
        self.hover_point = None
        self.paused = True
        self.current_frame = None
        self.window_name = f"Coordinate Picker - {os.path.basename(video_path)} ({self.mode.upper()})"

        # Multi-table mode state
        self.tables = []
        self.active_table_idx = 0
        self.editing_table_points = []
        self.save_feedback_timer = 0
        self.save_message = ""

        if self.mode == "tables":
            self._load_tables_config()

    def _load_tables_config(self):
        """Loads dining tables from restaurant rule yaml."""
        target_path = self.update_yaml
        if not target_path or not os.path.exists(target_path):
            if os.path.exists(RULES_DIR / "restaurant_counter.yaml"):
                target_path = str(RULES_DIR / "restaurant_counter.yaml")
            elif os.path.exists(RULES_DIR / "restaurant_table.yaml"):
                target_path = str(RULES_DIR / "restaurant_table.yaml")

        if target_path and os.path.exists(target_path):
            try:
                with open(target_path, "r") as f:
                    cfg = yaml.safe_load(f) or {}
                raw_tables = cfg.get("table_monitoring", {}).get("tables") or cfg.get("tables") or []
                self.tables = []
                for t in raw_tables:
                    self.tables.append({
                        "id": str(t.get("id", f"T{len(self.tables)+1}")),
                        "name": str(t.get("name", "")),
                        "capacity": int(t.get("capacity", 4)),
                        "confidence_threshold": t.get("confidence_threshold"),
                        "polygon": [[float(p[0]), float(p[1])] for p in t.get("polygon", [])]
                    })
                print(f"[Picker] Loaded {len(self.tables)} tables from {target_path}")
            except Exception as e:
                print(f"[Picker] Warning loading tables config: {e}")

        if not self.tables:
            print("[Picker] No tables found in config. Initializing default 9-table template.")
            # Default fallback template
            self.tables = [
                {"id": f"T{i+1}", "name": f"Table {i+1}", "capacity": 4, "polygon": []}
                for i in range(9)
            ]

    def mouse_callback(self, event, x, y, flags, param):
        self.hover_point = (x, y)

        if event == cv2.EVENT_LBUTTONDOWN:
            if self.mode == "tables":
                self.editing_table_points.append((x, y))
                pt_num = len(self.editing_table_points)
                t = self.tables[self.active_table_idx]
                print(f"[Picker] [{t['id']}: {t['name']}] Clicked Point {pt_num}: ({x}, {y})")

                # If 4 points clicked, update polygon for active table
                if len(self.editing_table_points) == 4 and self.current_frame is not None:
                    h, w = self.current_frame.shape[:2]
                    norm_poly = [[round(p[0] / w, 4), round(p[1] / h, 4)] for p in self.editing_table_points]
                    t["polygon"] = norm_poly
                    print(f"[Picker] >> Set new 4-point polygon for {t['id']} ({t['name']}): {norm_poly}")
                    self.save_message = f"Updated {t['id']} ({t['name']})! Press 's' to save."
                    self.save_feedback_timer = 45
                    self.editing_table_points = []
            elif self.mode == "line" and len(self.points) >= 2:
                self.points = [(x, y)]
                print(f"\n[Picker] Started new line at Point 1 (Start): ({x}, {y})")
                self._report_coordinates()
            else:
                self.points.append((x, y))
                pt_num = len(self.points)
                print(f"[Picker] Clicked Point {pt_num}: ({x}, {y})")
                self._report_coordinates()

        elif event == cv2.EVENT_LBUTTONDBLCLK and self.mode == "tables" and self.current_frame is not None:
            h, w = self.current_frame.shape[:2]
            for idx, t in enumerate(self.tables):
                if len(t.get("polygon", [])) >= 3:
                    poly = np.array([[int(p[0] * w), int(p[1] * h)] for p in t["polygon"]], dtype=np.int32)
                    if cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0:
                        self.active_table_idx = idx
                        self.editing_table_points.clear()
                        print(f"[Picker] >> Double-clicked and activated {t['id']} ({t['name']}) [{idx + 1}/{len(self.tables)}]")
                        break

        elif event == cv2.EVENT_RBUTTONDOWN:
            if self.mode == "tables":
                if self.editing_table_points:
                    removed = self.editing_table_points.pop()
                    print(f"[Picker] Removed point: {removed}")
            elif self.points:
                removed = self.points.pop()
                print(f"[Picker] Removed point: {removed}")
                self._report_coordinates()

    def _report_coordinates(self):
        if self.current_frame is None:
            return

        h, w = self.current_frame.shape[:2]

        print("\n" + "=" * 50)
        if self.mode == "line":
            if len(self.points) == 1:
                p1 = self.points[0]
                norm_start = [round(p1[0] / w, 4), round(p1[1] / h, 4)]
                print(f"Point 1 (Start): Pixel=({p1[0]}, {p1[1]}) | Normalized={norm_start}")
                print(">> Click Point 2 (End) to complete the tripwire.")
            elif len(self.points) >= 2:
                p1, p2 = self.points[0], self.points[1]
                norm_start = [round(p1[0] / w, 4), round(p1[1] / h, 4)]
                norm_end = [round(p2[0] / w, 4), round(p2[1] / h, 4)]

                print("YAML Configuration for services/engine/configs/rules/vehicle_gate.yaml:")
                print("-" * 50)
                yaml_snippet = (
                    "tripwire:\n"
                    f"  start: [{norm_start[0]:.2f}, {norm_start[1]:.2f}]\n"
                    f"  end: [{norm_end[0]:.2f}, {norm_end[1]:.2f}]"
                )
                print(yaml_snippet)
                print("-" * 50)
                print("Tip: Objects crossing from left-of-vector to right-of-vector count as IN (Entry).")

                if self.update_yaml and os.path.exists(self.update_yaml):
                    self._save_to_yaml(yaml_snippet)

        elif self.mode == "polygon":
            print(f"Current Polygon ({len(self.points)} points):")
            print("-" * 50)
            print("For services/engine/configs/rules/*.yaml (zone_polygon):")
            print("zone_polygon:")
            for pt in self.points:
                norm_pt = [round(pt[0] / w, 4), round(pt[1] / h, 4)]
                print(f"  - [{norm_pt[0]:.2f}, {norm_pt[1]:.2f}]")
            print("-" * 50)
            print("For inline in services/engine/configs/cameras.yaml (roi):")
            print("    roi:")
            for pt in self.points:
                norm_pt = [round(pt[0] / w, 4), round(pt[1] / h, 4)]
                print(f"      - [{norm_pt[0]:.2f}, {norm_pt[1]:.2f}]")
            print("-" * 50)

        print("=" * 50 + "\n")

    def _save_to_yaml(self, snippet: str):
        try:
            with open(self.update_yaml, "r") as f:
                content = f.read()

            new_content = re.sub(
                r"tripwire:\s*\n\s*start:\s*\[.*?\]\s*\n\s*end:\s*\[.*?\]",
                snippet,
                content
            )
            with open(self.update_yaml, "w") as f:
                f.write(new_content)
            print(f"[Picker] Successfully updated {self.update_yaml}!")
        except Exception as e:
            print(f"[Picker] Error updating YAML: {e}")

    def save_tables_to_yaml(self):
        """Saves current table polygons directly into restaurant YAML configs."""
        counter_yaml = str(RULES_DIR / "restaurant_counter.yaml")
        table_yaml = str(RULES_DIR / "restaurant_table.yaml")
        saved_paths = []

        # 1. Format for restaurant_counter.yaml (4-space indent under table_monitoring)
        counter_lines = ["  tables:"]
        for t in self.tables:
            counter_lines.append(f"    - id: \"{t['id']}\"")
            counter_lines.append(f"      name: \"{t['name']}\"")
            counter_lines.append(f"      capacity: {t.get('capacity', 4)}")
            if t.get('confidence_threshold') is not None:
                counter_lines.append(f"      confidence_threshold: {t['confidence_threshold']}")
            counter_lines.append("      polygon:")
            for p in t['polygon']:
                counter_lines.append(f"        - [{p[0]:.2f}, {p[1]:.2f}]")
            counter_lines.append("")
        counter_block = "\n".join(counter_lines)

        if os.path.exists(counter_yaml):
            try:
                with open(counter_yaml, "r") as f:
                    text = f.read()
                new_text = re.sub(r"  tables:\n(?:    - id:[\s\S]*)", counter_block, text)
                with open(counter_yaml, "w") as f:
                    f.write(new_text)
                saved_paths.append(counter_yaml)
            except Exception as e:
                print(f"[Picker] Error saving to {counter_yaml}: {e}")

        # 2. Format for restaurant_table.yaml (2-space indent)
        table_lines = ["tables:"]
        for t in self.tables:
            table_lines.append(f"  - id: \"{t['id']}\"")
            table_lines.append(f"    name: \"{t['name']}\"")
            table_lines.append(f"    capacity: {t.get('capacity', 4)}")
            if t.get('confidence_threshold') is not None:
                table_lines.append(f"    confidence_threshold: {t['confidence_threshold']}")
            table_lines.append("    polygon:")
            for p in t['polygon']:
                table_lines.append(f"      - [{p[0]:.2f}, {p[1]:.2f}]")
            table_lines.append("")
        table_block = "\n".join(table_lines) + "\n"

        if os.path.exists(table_yaml):
            try:
                with open(table_yaml, "r") as f:
                    text2 = f.read()
                new_text2 = re.sub(r"tables:\n(?:  - id:[\s\S]*?\n\n)(?=# Nx|\Z)", table_block, text2)
                with open(table_yaml, "w") as f:
                    f.write(new_text2)
                saved_paths.append(table_yaml)
            except Exception as e:
                print(f"[Picker] Error saving to {table_yaml}: {e}")

        if saved_paths:
            self.save_message = f"SAVED to: {', '.join(saved_paths)}!"
            self.save_feedback_timer = 90
            print(f"\n[Picker] >> SUCCESSFULLY SAVED {len(self.tables)} TABLES to: {', '.join(saved_paths)}\n")

    def run(self):
        if not os.path.exists(self.video_path):
            print(f"Error: Video file not found at '{self.video_path}'")
            return

        cap = cv2.VideoCapture(self.video_path)
        if not cap.isOpened():
            print(f"Error: Could not open video file '{self.video_path}'")
            return

        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        frame_delay = max(1, int(1000 / fps))

        cv2.namedWindow(self.window_name, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(self.window_name, self.mouse_callback)

        print("\n" + "=" * 65)
        print("  INTERACTIVE COORDINATE PICKER")
        print("=" * 65)
        print(f"Video: {w}x{h} @ {fps:.1f} FPS ({total_frames} frames)")
        print(f"Mode : {self.mode.upper()}")
        print("\nControls:")
        if self.mode == "tables":
            print("  - '1' - '9'  : Select Table T1 through T9")
            print("  - 'n' / 'p'  : Next / Previous Table")
            print("  - Left Click : Place 4 polygon corner points for active table")
            print("  - Right Click: Undo last point")
            print("  - 'c' key    : Clear points for active table")
            print("  - 's' key    : SAVE all tables directly to YAML configs")
        else:
            print("  - Left Click : Place point (Start / End for line, vertices for polygon)")
            print("  - Right Click: Undo last point")
            print("  - 'c' key    : Clear all points")

        print("  - SPACE key  : Pause / Resume playback")
        print("  - 'd' / 'a'  : Step forward / backward 15 frames")
        print("  - 'q' key    : Quit")
        print("=" * 65 + "\n")

        ret, frame = cap.read()
        if not ret:
            print("Failed to read first frame.")
            return
        self.current_frame = frame

        colors = [
            (0, 200, 255), (0, 255, 128), (255, 128, 0),
            (255, 0, 255), (0, 255, 255), (128, 255, 0),
            (255, 128, 128), (128, 128, 255), (200, 200, 0)
        ]

        while True:
            if not self.paused:
                ret, frame = cap.read()
                if not ret:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ret, frame = cap.read()
                self.current_frame = frame

            display = self.current_frame.copy()

            if self.mode == "tables":
                overlay = display.copy()

                # Draw all tables
                for idx, t in enumerate(self.tables):
                    is_active = (idx == self.active_table_idx)
                    pts_norm = t.get("polygon", [])

                    if len(pts_norm) >= 3:
                        poly = np.array([[int(p[0] * w), int(p[1] * h)] for p in pts_norm], dtype=np.int32)
                        col = (0, 255, 255) if is_active else colors[idx % len(colors)]
                        alpha = 0.25 if is_active else 0.12

                        cv2.fillPoly(overlay, [poly], col)
                        thickness = 3 if is_active else 1
                        cv2.polylines(display, [poly], isClosed=True, color=col, thickness=thickness)

                        # Label badge
                        moments = cv2.moments(poly)
                        if moments["m00"] != 0:
                            cx = int(moments["m10"] / moments["m00"])
                            cy = int(moments["m01"] / moments["m00"])
                        else:
                            cx, cy = int(np.mean(poly[:, 0])), int(np.mean(poly[:, 1]))

                        lbl = f"[{t['id']}] {t['name']}"
                        (tw, th), _ = cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
                        cv2.rectangle(display, (cx - tw // 2 - 4, cy - th // 2 - 4),
                                      (cx + tw // 2 + 4, cy + th // 2 + 4), (20, 20, 20), -1)
                        cv2.putText(display, lbl, (cx - tw // 2, cy + th // 2),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)

                # Blend translucent overlay
                cv2.addWeighted(overlay, 0.5, display, 0.5, 0, display)

                # Draw currently clicked editing points for active table
                if self.editing_table_points:
                    for i, pt in enumerate(self.editing_table_points):
                        cv2.circle(display, pt, 6, (0, 255, 255), -1)
                        cv2.putText(display, f"P{i+1}", (pt[0] + 8, pt[1] - 8),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                    if len(self.editing_table_points) > 1:
                        pts = np.array(self.editing_table_points, np.int32).reshape((-1, 1, 2))
                        cv2.polylines(display, [pts], isClosed=False, color=(0, 255, 255), thickness=2)
                    if self.hover_point:
                        cv2.line(display, self.editing_table_points[-1], self.hover_point, (0, 200, 200), 1, cv2.LINE_AA)

            elif self.mode == "line":
                if len(self.points) == 1:
                    cv2.circle(display, self.points[0], 6, (0, 255, 0), -1)
                    cv2.putText(display, "START", (self.points[0][0] + 10, self.points[0][1] - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                    if self.hover_point:
                        cv2.line(display, self.points[0], self.hover_point, (0, 255, 255), 1, cv2.LINE_AA)
                elif len(self.points) >= 2:
                    p1, p2 = self.points[0], self.points[1]
                    cv2.line(display, p1, p2, (0, 255, 255), 3, cv2.LINE_AA)
                    cv2.circle(display, p1, 7, (0, 255, 0), -1)
                    cv2.circle(display, p2, 7, (0, 0, 255), -1)
                    cv2.putText(display, f"START [{p1[0]/w:.2f}, {p1[1]/h:.2f}]", (p1[0] + 10, p1[1] - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                    cv2.putText(display, f"END [{p2[0]/w:.2f}, {p2[1]/h:.2f}]", (p2[0] + 10, p2[1] - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

                    mid_x = (p1[0] + p2[0]) // 2
                    mid_y = (p1[1] + p2[1]) // 2
                    dx = p2[0] - p1[0]
                    dy = p2[1] - p1[1]
                    length = max(1, int(np.hypot(dx, dy)))
                    nx = int(-dy / length * 35)
                    ny = int(dx / length * 35)
                    cv2.arrowedLine(display, (mid_x, mid_y), (mid_x + nx, mid_y + ny), (0, 200, 255), 2, tipLength=0.3)
                    cv2.putText(display, "ENTRY SIDE", (mid_x + nx + 5, mid_y + ny), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)

            elif self.mode == "polygon":
                if len(self.points) > 0:
                    for i, pt in enumerate(self.points):
                        cv2.circle(display, pt, 5, (0, 255, 0), -1)
                        cv2.putText(display, f"P{i+1}", (pt[0] + 8, pt[1] - 8),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
                    if len(self.points) > 1:
                        pts = np.array(self.points, np.int32).reshape((-1, 1, 2))
                        cv2.polylines(display, [pts], isClosed=True, color=(0, 255, 255), thickness=2)

            # Draw top HUD
            hud_h = 70
            hud_bg = display[:hud_h, :].copy()
            cv2.rectangle(display, (0, 0), (w, hud_h), (25, 25, 25), -1)
            display[:hud_h, :] = cv2.addWeighted(hud_bg, 0.25, display[:hud_h, :], 0.75, 0)

            status = "PAUSED (Click points)" if self.paused else "PLAYING (SPACE to pause)"

            if self.mode == "tables":
                active_t = self.tables[self.active_table_idx]
                pts_count = len(self.editing_table_points)
                cv2.putText(display, f"TABLE CALIBRATION | ACTIVE: [{active_t['id']}] {active_t['name']} [{self.active_table_idx+1}/{len(self.tables)}] ({pts_count}/4 pts) | {status}",
                            (20, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
                cv2.putText(display, "Keys: 1-9/0: Jump | 'n'/'p': Cycle All | '+': Add Table | '-': Delete | L-Click: 4 Corners | 's': SAVE | 'q': Exit",
                            (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 220, 255), 1)
            else:
                cv2.putText(display, f"Mode: {self.mode.upper()} | Status: {status}", (20, 25),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                cv2.putText(display, "L-Click: Set Point | R-Click: Undo | 'c': Clear | SPACE: Play/Pause | 'q': Exit",
                            (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 220, 255), 1)

            # Hover info
            if self.hover_point:
                hx, hy = self.hover_point
                cv2.putText(display, f"X:{hx} Y:{hy} ({hx/w:.3f}, {hy/h:.3f})", (w - 240, 25),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0, 255, 255), 1)

            # Save feedback notification banner
            if self.save_feedback_timer > 0:
                self.save_feedback_timer -= 1
                (bw, bh), _ = cv2.getTextSize(self.save_message, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                cv2.rectangle(display, (w // 2 - bw // 2 - 15, h - 60), (w // 2 + bw // 2 + 15, h - 20), (0, 160, 0), -1)
                cv2.putText(display, self.save_message, (w // 2 - bw // 2, h - 35),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

            cv2.imshow(self.window_name, display)

            key = cv2.waitKey(frame_delay if not self.paused else 30) & 0xFF
            if key == ord('q'):
                break
            elif key == ord(' '):
                self.paused = not self.paused
            elif key == ord('s') and self.mode == "tables":
                self.save_tables_to_yaml()
            elif key == ord('c'):
                if self.mode == "tables":
                    self.editing_table_points.clear()
                    print(f"[Picker] Cleared points for {self.tables[self.active_table_idx]['id']}.")
                else:
                    self.points.clear()
                    print("[Picker] Cleared points.")
            elif key in [ord('n'), ord('N')] and self.mode == "tables":
                self.active_table_idx = (self.active_table_idx + 1) % len(self.tables)
                self.editing_table_points.clear()
                print(f"[Picker] Switched to {self.tables[self.active_table_idx]['id']} ({self.tables[self.active_table_idx]['name']}) [{self.active_table_idx + 1}/{len(self.tables)}]")
            elif key in [ord('p'), ord('P')] and self.mode == "tables":
                self.active_table_idx = (self.active_table_idx - 1) % len(self.tables)
                self.editing_table_points.clear()
                print(f"[Picker] Switched to {self.tables[self.active_table_idx]['id']} ({self.tables[self.active_table_idx]['name']}) [{self.active_table_idx + 1}/{len(self.tables)}]")
            elif ord('1') <= key <= ord('9') and self.mode == "tables":
                target_idx = key - ord('1')
                if target_idx < len(self.tables):
                    self.active_table_idx = target_idx
                    self.editing_table_points.clear()
                    print(f"[Picker] Switched to {self.tables[self.active_table_idx]['id']} ({self.tables[self.active_table_idx]['name']}) [{self.active_table_idx + 1}/{len(self.tables)}]")
            elif key == ord('0') and self.mode == "tables":
                if len(self.tables) >= 10:
                    self.active_table_idx = 9
                    self.editing_table_points.clear()
                    print(f"[Picker] Switched to {self.tables[self.active_table_idx]['id']} ({self.tables[self.active_table_idx]['name']}) [10/{len(self.tables)}]")
            elif key in [ord('+'), ord('='), ord('t'), ord('T')] and self.mode == "tables":
                new_num = len(self.tables) + 1
                new_t = {
                    "id": f"T{new_num}",
                    "name": f"Table {new_num}",
                    "capacity": 4,
                    "polygon": []
                }
                self.tables.append(new_t)
                self.active_table_idx = len(self.tables) - 1
                self.editing_table_points.clear()
                self.save_message = f"Added {new_t['id']}! Click 4 corners, then press 's' to save."
                self.save_feedback_timer = 90
                print(f"\n[Picker] >> ADDED NEW TABLE: {new_t['id']} (Total tables: {len(self.tables)}). Click 4 corners to set polygon.")
            elif key in [ord('-'), ord('_'), ord('x'), ord('X')] and self.mode == "tables":
                if len(self.tables) > 1:
                    removed = self.tables.pop(self.active_table_idx)
                    self.active_table_idx = max(0, min(self.active_table_idx, len(self.tables) - 1))
                    self.editing_table_points.clear()
                    self.save_message = f"Removed {removed['id']}. Press 's' to save changes."
                    self.save_feedback_timer = 90
                    print(f"\n[Picker] >> REMOVED TABLE: {removed['id']} (Remaining: {len(self.tables)}). Press 's' to save.")
            elif key == ord('d'):
                curr = cap.get(cv2.CAP_PROP_POS_FRAMES)
                cap.set(cv2.CAP_PROP_POS_FRAMES, min(total_frames - 1, curr + 15))
                ret, frame = cap.read()
                if ret:
                    self.current_frame = frame
            elif key == ord('a'):
                curr = cap.get(cv2.CAP_PROP_POS_FRAMES)
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, curr - 15))
                ret, frame = cap.read()
                if ret:
                    self.current_frame = frame

        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Interactive Tripwire, Zone, and Dining Table Coordinate Picker")
    parser.add_argument("--video", required=True, help="Path to .mp4 video file")
    parser.add_argument("--mode", choices=["line", "polygon", "tables"], default="line",
                        help="line for tripwire, polygon for area zone, tables for restaurant dining tables")
    parser.add_argument("--update-yaml", default=None, help="Path to rule YAML file to update automatically")
    args = parser.parse_args()

    picker = CoordinatePicker(args.video, mode=args.mode, update_yaml=args.update_yaml)
    picker.run()
