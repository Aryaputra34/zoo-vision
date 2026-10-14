"""Draws the five demo stills the demo feeder serves as camera frames.

Each is a 1280x720 scene of flat shapes on a grid, labelled DEMO. No footage and no people: the backend
repo is public and real frames show park visitors. The shapes follow the example settings of each use
case, so a zone drawn in the editor lines up with them.

Run from the repo root:
    uv run --project services/engine python tools/make_demo_frames.py
Writes apps/api/demo/frames/<use case>.jpg (JPEG quality 80).
"""
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
USECASES = ROOT / "packages" / "contracts" / "usecases"
OUT = ROOT / "apps" / "api" / "demo" / "frames"
W, H = 1280, 720

FLOOR = (214, 218, 222)
GRID = (196, 200, 205)
TEXT = (60, 64, 70)
FONT = cv2.FONT_HERSHEY_SIMPLEX


def settings(use_case: str) -> dict:
    path = USECASES / use_case / "examples" / "settings" / "valid" / "current_rules.json"
    return json.loads(path.read_text(encoding="utf-8"))


def px(point) -> tuple[int, int]:
    return int(point[0] * (W - 1)), int(point[1] * (H - 1))


def polygon(img, points, fill, edge=None):
    pts = np.array([px(p) for p in points], np.int32)
    cv2.fillPoly(img, [pts], fill)
    if edge is not None:
        cv2.polylines(img, [pts], True, edge, 2, cv2.LINE_AA)
    return pts


def label(img, text, at, scale=0.7, color=TEXT, thickness=2):
    cv2.putText(img, text, at, FONT, scale, color, thickness, cv2.LINE_AA)


def base(title: str) -> np.ndarray:
    img = np.full((H, W, 3), FLOOR, np.uint8)
    for x in range(0, W, 80):
        cv2.line(img, (x, 0), (x, H), GRID, 1)
    for y in range(0, H, 80):
        cv2.line(img, (0, y), (W, y), GRID, 1)
    cv2.rectangle(img, (0, 0), (W, 56), (52, 58, 66), -1)
    label(img, f"DEMO  |  {title}", (24, 38), 0.95, (240, 240, 240))
    label(img, "synthetic scene", (W - 250, H - 18), 0.6, (120, 124, 130), 1)
    return img


def cashier_presence() -> np.ndarray:
    s = settings("cashier_presence")
    img = base("cashier desk")
    polygon(img, s["visitor_zone"], (232, 226, 210), (150, 140, 110))
    polygon(img, s["clerk_zone"], (190, 205, 225), (90, 110, 150))
    cx, cy = px([0.52, 0.62])
    cv2.rectangle(img, (cx - 150, cy - 40), (cx + 150, cy + 40), (120, 100, 80), -1)  # the counter
    cv2.rectangle(img, (cx - 40, cy - 90), (cx + 40, cy - 40), (80, 86, 96), -1)  # the till
    label(img, "COUNTER", (cx - 62, cy + 8))
    label(img, "CLERK ZONE", px([0.4, 0.92]), 0.6)
    label(img, "QUEUE", px([0.45, 0.2]), 0.6)
    return img


def horse_riding() -> np.ndarray:
    s = settings("horse_riding")
    img = base("pony rides")
    cv2.ellipse(img, (W // 2 - 60, H // 2 + 10), (470, 250), 0, 0, 360, (186, 208, 170), -1, cv2.LINE_AA)
    cv2.ellipse(img, (W // 2 - 60, H // 2 + 10), (470, 250), 0, 0, 360, (110, 140, 90), 3, cv2.LINE_AA)
    cv2.ellipse(img, (W // 2 - 60, H // 2 + 10), (250, 110), 0, 0, 360, (206, 224, 192), -1, cv2.LINE_AA)
    label(img, "ARENA", (W // 2 - 120, H // 2 + 20), 0.9)
    gate = s["tripwire"]
    cv2.line(img, px(gate["start"]), px(gate["end"]), (60, 70, 160), 10, cv2.LINE_AA)
    label(img, "GATE", (px(gate["start"])[0] - 90, px(gate["start"])[1] + 30), 0.7, (60, 70, 160))
    return img


def vehicle_gate() -> np.ndarray:
    s = settings("vehicle_gate")
    img = base("vehicle gate")
    polygon(img, s["roi_polygon"], (150, 154, 160), (96, 100, 108))
    for t in np.linspace(0.05, 0.95, 14):  # dashed centre line along the road
        a = (int(60 + t * 640), int(150 + t * 420))
        b = (int(60 + (t + 0.03) * 640), int(150 + (t + 0.03) * 420))
        cv2.line(img, a, b, (235, 235, 235), 5, cv2.LINE_AA)
    barrier = s["tripwire"]
    cv2.line(img, px(barrier["start"]), px(barrier["end"]), (30, 60, 200), 12, cv2.LINE_AA)
    label(img, "BARRIER", (px(barrier["end"])[0] + 10, px(barrier["end"])[1] - 18), 0.7, (30, 60, 200))
    cv2.rectangle(img, (1010, 360), (1180, 560), (120, 130, 140), -1)  # the guard house
    label(img, "GUARD", (1030, 470), 0.7, (240, 240, 240))
    return img


def tables(use_case: str, title: str) -> np.ndarray:
    s = settings(use_case)
    img = base(title)
    items = s["tables"] if "tables" in s else s["table_monitoring"]["tables"]
    for table in items:
        pts = polygon(img, table["polygon"], (170, 190, 150), (90, 120, 70))
        cx, cy = pts.mean(axis=0).astype(int)
        label(img, table["id"], (int(cx) - 14, int(cy) + 6), 0.55)
    return img


FRAMES = {
    "cashier_presence": cashier_presence,
    "horse_riding": horse_riding,
    "restaurant_counter": lambda: tables("restaurant_counter", "restaurant counter"),
    "restaurant_table": lambda: tables("restaurant_table", "restaurant tables"),
    "vehicle_gate": vehicle_gate,
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, draw in FRAMES.items():
        path = OUT / f"{name}.jpg"
        ok, encoded = cv2.imencode(".jpg", draw(), [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            raise SystemExit(f"could not encode {name}")
        path.write_bytes(encoded.tobytes())
        print(f"{path.relative_to(ROOT)}  {len(encoded) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
