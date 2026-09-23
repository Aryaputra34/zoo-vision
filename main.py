"""
Zoo & Safari Computer Vision Orchestrator (Phase 1 Master Entrypoint).
Loads camera definitions, connects to Nx Meta REST API v3, and coordinates vision pipelines.
"""

import os
import sys
import time
import argparse
import logging
import signal
import yaml
import cv2

from nx_integration.nx_client import NxClient
from core.stream_manager import StreamManager
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (%(name)s) %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("MainOrchestrator")


def load_yaml(path: str) -> dict:
    if not os.path.exists(path):
        logger.error(f"Config file not found: {path}")
        return {}
    with open(path, "r") as f:
        return yaml.safe_load(f) or {}


def main():
    parser = argparse.ArgumentParser(description="Zoo Vision Analytics Service")
    parser.add_argument("--app-config", default="configs/app_config.yaml", help="Path to app config")
    parser.add_argument("--cameras-config", default="configs/cameras.yaml", help="Path to cameras config")
    parser.add_argument("--preview", action="store_true", help="Display live OpenCV window preview")
    args = parser.parse_args()

    logger.info("Starting Zoo & Safari Computer Vision Service (Phase 1)...")

    app_cfg = load_yaml(args.app_config)
    cam_cfg = load_yaml(args.cameras_config)

    # 1. Initialize Nx Meta Client
    nx_cfg = app_cfg.get("nx_server", {})
    nx_client = NxClient(
        host=nx_cfg.get("host", "127.0.0.1"),
        port=nx_cfg.get("port", 7001),
        username=nx_cfg.get("auth", {}).get("username", "admin"),
        password=nx_cfg.get("auth", {}).get("password", "admin"),
        token=nx_cfg.get("auth", {}).get("token", ""),
        use_https=nx_cfg.get("use_https", True),
        verify_ssl=nx_cfg.get("verify_ssl", False),
        mock_mode=nx_cfg.get("mock_mode", True)
    )

    device = app_cfg.get("ai_engine", {}).get("device", "cpu")

    # 2. Build Pipeline Registry
    active_pipelines = []
    active_streams = []

    for cam in cam_cfg.get("cameras", []):
        if not cam.get("enabled", True):
            continue

        cam_id = cam.get("id")
        name = cam.get("name", cam_id)
        source = str(cam.get("source", "0"))
        pipeline_type = cam.get("pipeline")
        rule_path = cam.get("rule_config", "")
        nx_id = cam.get("nx_camera_id", "00000000-0000-0000-0000-000000000000")
        target_fps = cam.get("target_fps", 10)
        roi = cam.get("roi")
        inline_rules = cam.get("rules")

        # Instantiate specific pipeline
        if pipeline_type == "cashier_presence":
            pipeline = CashierPresencePipeline(
                cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
            )
        elif pipeline_type == "restaurant_counter":
            pipeline = RestaurantCounterPipeline(
                cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
            )
        elif pipeline_type == "vehicle_gate":
            pipeline = VehicleGatePipeline(
                cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
            )
        else:
            logger.warning(f"Unknown pipeline type '{pipeline_type}' for camera '{name}'. Skipping.")
            continue

        # Ingest stream
        stream = StreamManager(source=source, camera_id=cam_id, target_fps=target_fps)
        stream.start()

        active_pipelines.append((cam_id, name, stream, pipeline))
        active_streams.append(stream)

    if not active_pipelines:
        logger.warning("No enabled cameras found in cameras.yaml. Exiting.")
        return

    logger.info(f"Initialized {len(active_pipelines)} active vision pipeline(s). Entering main inference loop...")

    running = True

    def sigint_handler(sig, frame):
        nonlocal running
        logger.info("Shutdown signal received. Stopping streams...")
        running = False

    signal.signal(signal.SIGINT, sigint_handler)

    try:
        while running:
            for cam_id, name, stream, pipeline in active_pipelines:
                frame, timestamp_ms = stream.get_frame()
                if frame is None:
                    continue

                # Run inference & business logic
                annotated = pipeline.process_frame(frame, timestamp_ms)

                # Optional desktop GUI preview
                if args.preview:
                    cv2.imshow(f"Zoo Vision: {name}", annotated)

            if args.preview:
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    logger.info("Quit key pressed ('q'). Exiting...")
                    break

            time.sleep(0.01)

    finally:
        logger.info("Cleaning up resources...")
        for stream in active_streams:
            stream.stop()
        if args.preview:
            cv2.destroyAllWindows()
        logger.info("Zoo Vision Service successfully stopped.")


if __name__ == "__main__":
    main()
