"""
Interactive Coordinate Picker for Tripwires and Polygons.

Usage:
    python pick_coordinates.py --video "path/to/video.mp4"
    python pick_coordinates.py --video "path/to/video.mp4" --mode polygon
"""

import os
import sys
import argparse
import cv2
import numpy as np


class CoordinatePicker:
    def __init__(self, video_path: str, mode: str = "line", update_yaml: str = None):
        self.video_path = video_path
        self.mode = mode  # "line" or "polygon"
        self.update_yaml = update_yaml
        self.points = []  # Store raw pixel points [(x, y), ...]
        self.hover_point = None
        self.paused = True
        self.current_frame = None
        self.window_name = f"Coordinate Picker - {os.path.basename(video_path)} ({self.mode.upper()})"

    def mouse_callback(self, event, x, y, flags, param):
        self.hover_point = (x, y)

        if event == cv2.EVENT_LBUTTONDOWN:
            if self.mode == "line" and len(self.points) >= 2:
                # Reset if already have 2 points for line
                self.points = [(x, y)]
                print(f"\n[Picker] Started new line at Point 1 (Start): ({x}, {y})")
            else:
                self.points.append((x, y))
                pt_num = len(self.points)
                print(f"[Picker] Clicked Point {pt_num}: ({x}, {y})")

            self._report_coordinates()

        elif event == cv2.EVENT_RBUTTONDOWN:
            # Right click to undo last point
            if self.points:
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

                print("YAML Configuration for configs/rules/vehicle_gate.yaml:")
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
            print("For configs/rules/*.yaml (zone_polygon):")
            print("zone_polygon:")
            for pt in self.points:
                norm_pt = [round(pt[0] / w, 4), round(pt[1] / h, 4)]
                print(f"  - [{norm_pt[0]:.2f}, {norm_pt[1]:.2f}]")
            print("-" * 50)
            print("For inline in configs/cameras.yaml (roi):")
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

            import re
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

        print("\n" + "=" * 60)
        print("  INTERACTIVE COORDINATE PICKER")
        print("=" * 60)
        print(f"Video: {w}x{h} @ {fps:.1f} FPS ({total_frames} frames)")
        print("\nControls:")
        print("  - Left Click   : Place point (Start / End for line, vertices for polygon)")
        print("  - Right Click  : Undo last point")
        print("  - 'c' key      : Clear all points")
        print("  - SPACE key    : Pause / Resume playback")
        print("  - 'd' / 'a'    : Step forward / backward 15 frames")
        print("  - 'q' key      : Quit")
        print("=" * 60 + "\n")

        ret, frame = cap.read()
        if not ret:
            print("Failed to read first frame.")
            return
        self.current_frame = frame

        while True:
            if not self.paused:
                ret, frame = cap.read()
                if not ret:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ret, frame = cap.read()
                self.current_frame = frame

            display = self.current_frame.copy()

            # Draw current points and lines
            if self.mode == "line":
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

                    # Direction vector arrow
                    mid_x = (p1[0] + p2[0]) // 2
                    mid_y = (p1[1] + p2[1]) // 2
                    dx = p2[0] - p1[0]
                    dy = p2[1] - p1[1]
                    length = max(1, int(np.hypot(dx, dy)))
                    # Normal vector pointing to the "IN" side (right of vector p1->p2)
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
            hud_bg = display[:60, :].copy()
            cv2.rectangle(display, (0, 0), (w, 60), (30, 30, 30), -1)
            display[:60, :] = cv2.addWeighted(hud_bg, 0.3, display[:60, :], 0.7, 0)

            status = "PAUSED (Click points)" if self.paused else "PLAYING (Press SPACE to pause)"
            cv2.putText(display, f"Mode: {self.mode.upper()} | Status: {status}", (20, 25),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(display, "L-Click: Set Point | R-Click: Undo | 'c': Clear | SPACE: Play/Pause | 'q': Exit",
                        (20, 48), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 220, 255), 1)

            # Hover info
            if self.hover_point:
                hx, hy = self.hover_point
                cv2.putText(display, f"X:{hx} Y:{hy} ({hx/w:.3f}, {hy/h:.3f})", (w - 240, 25),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)

            cv2.imshow(self.window_name, display)

            key = cv2.waitKey(frame_delay if not self.paused else 30) & 0xFF
            if key == ord('q'):
                break
            elif key == ord(' '):
                self.paused = not self.paused
            elif key == ord('c'):
                self.points.clear()
                print("[Picker] Cleared points.")
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
    parser = argparse.ArgumentParser(description="Interactive Tripwire / Zone Coordinate Picker")
    parser.add_argument("--video", required=True, help="Path to .mp4 video file")
    parser.add_argument("--mode", choices=["line", "polygon"], default="line", help="line for tripwire, polygon for area zone")
    parser.add_argument("--update-yaml", default=None, help="Path to rule YAML file to update automatically")
    args = parser.parse_args()

    picker = CoordinatePicker(args.video, mode=args.mode, update_yaml=args.update_yaml)
    picker.run()
