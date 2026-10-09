"""
Zoo & Safari Computer Vision Orchestrator (Phase 1 Master Entrypoint).
Loads camera definitions, runs one inference worker thread per camera, and serves the dashboard API
(live preview + event snapshots). Nx Meta REST v3 bookmarks are optional (nx_server.mock_mode).
"""

import os
import sys
import argparse
import logging
import signal
import threading
from typing import Optional
import yaml
import cv2

from nx_integration.nx_client import NxClient
from core.base_pipeline import BasePipeline
from core.analytics_dispatcher import AnalyticsDispatcher
from core.api_server import create_app, start_api_server
from core.snapshot_store import SnapshotStore
from core.stream_manager import StreamManager
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline
from pipelines.table_occupancy_pipeline import TableOccupancyPipeline
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline
from pipelines.horse_riding_pipeline import HorseRidingPipeline

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


def camera_worker(name: str, stream: StreamManager, pipeline, stop: threading.Event):
    """Inference loop for one camera. Cameras run in parallel; YOLO / ONNX release the GIL while inferring."""
    last_ts = None
    while not stop.is_set():
        frame, timestamp_ms = stream.get_frame()
        # A dead stream keeps returning its last frame: skip it so we don't re-run YOLO
        # or keep sending dashboard heartbeats for a camera that is actually down.
        if frame is None or timestamp_ms == last_ts:
            stop.wait(0.01)
            continue
        last_ts = timestamp_ms
        try:
            pipeline.run(frame, timestamp_ms)
        except Exception:
            # One camera's failure must not stop the others
            logger.exception(f"[{name}] Pipeline error, skipping frame")
            stop.wait(1.0)


def create_pipeline(cam: dict, nx_client: NxClient, device: str) -> Optional[BasePipeline]:
    """Builds the pipeline a camera entry from cameras.yaml asks for; None for an unknown type."""
    cam_id = cam.get("id")
    name = cam.get("name", cam_id)
    pipeline_type = cam.get("pipeline")
    rule_path = cam.get("rule_config", "")
    nx_id = cam.get("nx_camera_id", "00000000-0000-0000-0000-000000000000")
    roi = cam.get("roi")
    inline_rules = cam.get("rules")

    if pipeline_type == "cashier_presence":
        return CashierPresencePipeline(
            cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
        )
    elif pipeline_type in ["restaurant_counter", "restaurant"]:
        return RestaurantCounterPipeline(
            cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
        )
    elif pipeline_type in ["restaurant_table", "table_occupancy", "table_monitor"]:
        return TableOccupancyPipeline(
            cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
        )
    elif pipeline_type == "vehicle_gate":
        return VehicleGatePipeline(
            cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
        )
    elif pipeline_type in ["horse_riding", "horse_tracking", "horse"]:
        return HorseRidingPipeline(
            cam_id, name, nx_id, rule_path, nx_client, device=device, roi=roi, rules=inline_rules
        )
    logger.warning(f"Unknown pipeline type '{pipeline_type}' for camera '{name}'. Skipping.")
    return None


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

    # Web analytics dashboard (zoo-vision-fe)
    an_cfg = app_cfg.get("analytics", {})
    analytics = AnalyticsDispatcher(
        api_url=an_cfg.get("api_url", "http://localhost:3000/api/events"),
        api_key=an_cfg.get("api_key") or None,
    ) if an_cfg.get("enabled") else None

    # One JPEG per dashboard event, served by the API server below
    snap_cfg = app_cfg.get("snapshots", {})
    snapshots = SnapshotStore(
        root=snap_cfg.get("dir", "snapshots"),
        retention_days=snap_cfg.get("retention_days", 30),
    ) if analytics and snap_cfg.get("enabled", True) else None

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
        target_fps = cam.get("target_fps", 10)

        # Instantiate specific pipeline
        pipeline = create_pipeline(cam, nx_client, device)
        if pipeline is None:
            continue
        pipeline.analytics = analytics
        pipeline.snapshots = snapshots
        pipeline.recording_path = cam.get("recording_path")  # MediaMTX path, for event clips in the dashboard

        # Ingest stream
        stream = StreamManager(source=source, camera_id=cam_id, target_fps=target_fps)
        stream.start()

        active_pipelines.append((cam_id, name, stream, pipeline))
        active_streams.append(stream)

    if not active_pipelines:
        logger.warning("No enabled cameras found in cameras.yaml. Exiting.")
        return

    # Dashboard API: annotated live preview, event snapshots, health
    api_cfg = app_cfg.get("api_server", {})
    api_server = start_api_server(
        create_app({cam_id: p for cam_id, _, _, p in active_pipelines}, snapshots, api_cfg.get("api_key") or None),
        host=api_cfg.get("host", "127.0.0.1"),
        port=api_cfg.get("port", 8000),
    ) if api_cfg.get("enabled", True) else None

    stop = threading.Event()

    def shutdown_handler(sig, frame):
        logger.info("Shutdown signal received. Stopping streams...")
        stop.set()

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)  # docker stop / systemctl stop

    workers = [
        threading.Thread(target=camera_worker, args=(name, stream, pipeline, stop), daemon=True, name=f"cam-{cam_id}")
        for cam_id, name, stream, pipeline in active_pipelines
    ]
    for w in workers:
        w.start()
    logger.info(f"Started {len(workers)} camera worker(s).")

    try:
        while not stop.is_set():
            if not args.preview:
                stop.wait(0.5)
                continue
            # OpenCV windows must be driven from the main thread
            for _, name, _, pipeline in active_pipelines:
                annotated = pipeline.latest_frame()
                if annotated is not None:
                    cv2.imshow(f"Zoo Vision: {name}", annotated)
            if cv2.waitKey(30) & 0xFF == ord('q'):
                logger.info("Quit key pressed ('q'). Exiting...")
                break

    finally:
        logger.info("Cleaning up resources...")
        stop.set()
        for w in workers:
            w.join(timeout=10.0)  # let an in-flight inference finish before its stream is released
        for stream in active_streams:
            stream.stop()
        if api_server:
            api_server.should_exit = True
        if snapshots:
            snapshots.stop()
        if analytics:
            analytics.stop()
        if args.preview:
            cv2.destroyAllWindows()
        logger.info("Zoo Vision Service successfully stopped.")


if __name__ == "__main__":
    main()
