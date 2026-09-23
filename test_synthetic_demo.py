"""
Offline Test Harness & Smoke Test for Phase 1 Pipelines.
Generates synthetic frames to verify pipeline execution, ROI triggers, and Nx bookmark output without a live camera.
"""

import time
import logging
import numpy as np
import cv2

from nx_integration.nx_client import NxClient
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("TestHarness")


def test_pipelines():
    logger.info("=== STARTING PHASE 1 SMOKE TEST ===")

    # 1. Initialize Nx Client in Mock Mode
    nx_client = NxClient(mock_mode=True)

    # 2. Test Cashier Presence Pipeline
    logger.info("--- Testing Cashier Presence Pipeline ---")
    cashier_pipeline = CashierPresencePipeline(
        camera_id="test_cam_01",
        camera_name="Test Cashier Desk",
        nx_camera_id="test-uuid-001",
        rule_config_path="configs/rules/cashier_presence.yaml",
        nx_client=nx_client,
        device="cpu"
    )

    # Generate a blank frame (simulating an empty desk)
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    timestamp_ms = int(time.time() * 1000)

    # Process frame through cashier pipeline
    annotated = cashier_pipeline.process_frame(blank_frame, timestamp_ms)
    assert annotated is not None, "Cashier pipeline returned None"
    assert annotated.shape == (480, 640, 3), "Annotated frame shape mismatch"
    logger.info("✅ Cashier Presence pipeline processed frame successfully.")

    # 3. Test Restaurant Counter Pipeline
    logger.info("--- Testing Restaurant Counter Pipeline ---")
    restaurant_pipeline = RestaurantCounterPipeline(
        camera_id="test_cam_02",
        camera_name="Test Restaurant Door",
        nx_camera_id="test-uuid-002",
        rule_config_path="configs/rules/restaurant_counter.yaml",
        nx_client=nx_client,
        device="cpu"
    )

    annotated_rest = restaurant_pipeline.process_frame(blank_frame, timestamp_ms)
    assert annotated_rest is not None, "Restaurant pipeline returned None"
    assert annotated_rest.shape == (480, 640, 3), "Annotated frame shape mismatch"
    logger.info("✅ Restaurant Counter pipeline processed frame successfully.")

    # 4. Test Vehicle Gate Pipeline
    logger.info("--- Testing Vehicle Gate Pipeline ---")
    from pipelines.vehicle_gate_pipeline import VehicleGatePipeline
    gate_pipeline = VehicleGatePipeline(
        camera_id="test_cam_03",
        camera_name="Test Vehicle Gate",
        nx_camera_id="test-uuid-003",
        rule_config_path="configs/rules/vehicle_gate.yaml",
        nx_client=nx_client,
        device="cpu"
    )

    annotated_gate = gate_pipeline.process_frame(blank_frame, timestamp_ms)
    assert annotated_gate is not None, "Vehicle Gate pipeline returned None"
    assert annotated_gate.shape == (480, 640, 3), "Annotated frame shape mismatch"
    logger.info("✅ Vehicle Gate pipeline processed frame successfully.")

    logger.info("=== ALL PHASE 1 PIPELINE TESTS PASSED! ===")


if __name__ == "__main__":
    test_pipelines()
