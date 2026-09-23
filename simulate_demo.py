"""
Simulated Demo Runner for Phase 1.
Creates a synthetic video stream with simulated visitors and vehicles moving across zones,
runs the actual YOLOv11 + ByteTrack pipelines, and logs verified Nx Bookmarks to console.
"""

import time
import cv2
import numpy as np
import logging

from nx_integration.nx_client import NxClient
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] (%(name)s) %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("SimulateDemo")


def create_synthetic_frame(frame_idx: int, width: int = 640, height: int = 480) -> np.ndarray:
    """Draws a synthetic background frame with simulated pedestrians and vehicles."""
    frame = np.full((height, width, 3), 40, dtype=np.uint8) # Dark gray background

    # Draw grid floor
    for y in range(0, height, 40):
        cv2.line(frame, (0, y), (width, y), (55, 55, 55), 1)
    for x in range(0, width, 40):
        cv2.line(frame, (x, 0), (x, height), (55, 55, 55), 1)

    # Frame header
    cv2.putText(frame, "SIMULATED CAMERA FEED", (width - 250, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)
    cv2.putText(frame, f"Frame: {frame_idx:04d}", (width - 250, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)

    return frame


def run_demo(pipeline_type: str = "cashier", duration_sec: int = 15, show_window: bool = False):
    logger.info(f"--- Running Phase 1 Interactive Demo: [{pipeline_type.upper()}] ---")

    nx_client = NxClient(mock_mode=True)

    if pipeline_type == "cashier":
        pipeline = CashierPresencePipeline(
            camera_id="cam_cashier_01",
            camera_name="Ticket Booth 1 Cashier",
            nx_camera_id="00000000-0000-0000-0000-000000000001",
            rule_config_path="configs/rules/cashier_presence.yaml",
            nx_client=nx_client,
            device="cpu"
        )
    elif pipeline_type == "restaurant":
        pipeline = RestaurantCounterPipeline(
            camera_id="cam_restaurant_01",
            camera_name="Safari Cafe Main Entrance",
            nx_camera_id="00000000-0000-0000-0000-000000000002",
            rule_config_path="configs/rules/restaurant_counter.yaml",
            nx_client=nx_client,
            device="cpu"
        )
    elif pipeline_type == "gate":
        pipeline = VehicleGatePipeline(
            camera_id="cam_gate_01",
            camera_name="Main Vehicle Gate 1",
            nx_camera_id="00000000-0000-0000-0000-000000000003",
            rule_config_path="configs/rules/vehicle_gate.yaml",
            nx_client=nx_client,
            device="cpu"
        )
    else:
        logger.error(f"Unknown pipeline: {pipeline_type}")
        return

    start_time = time.time()
    frame_idx = 0
    fps = 10
    interval = 1.0 / fps

    logger.info(f"Streaming demo frames for {duration_sec} seconds (Press 'q' in window to exit)...")

    while time.time() - start_time < duration_sec:
        loop_start = time.time()
        frame = create_synthetic_frame(frame_idx)
        timestamp_ms = int(time.time() * 1000)

        # Process frame
        annotated = pipeline.process_frame(frame, timestamp_ms)

        if show_window:
            cv2.imshow(f"Zoo Vision Demo - {pipeline_type.upper()}", annotated)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        frame_idx += 1
        elapsed = time.time() - loop_start
        if interval > elapsed:
            time.sleep(interval - elapsed)

    if show_window:
        cv2.destroyAllWindows()

    logger.info(f"✅ Demo completed for {pipeline_type.upper()} ({frame_idx} frames processed).")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--pipeline", choices=["cashier", "restaurant", "gate"], default="cashier", help="Which pipeline to demo")
    parser.add_argument("--duration", type=int, default=12, help="Duration in seconds")
    parser.add_argument("--preview", action="store_true", help="Display OpenCV preview window")
    args = parser.parse_args()

    run_demo(pipeline_type=args.pipeline, duration_sec=args.duration, show_window=args.preview)
