import numpy as np
import pytest
import yaml
from conftest import ENGINE_DIR
from main import create_pipeline
from nx_integration.nx_client import NxClient
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.horse_riding_pipeline import HorseRidingPipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline
from pipelines.table_occupancy_pipeline import TableOccupancyPipeline
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline

RULES = {
    "cashier_presence": "configs/rules/cashier_presence.yaml",
    "restaurant_counter": "configs/rules/restaurant_counter.yaml",
    "restaurant_table": "configs/rules/restaurant_table.yaml",
    "vehicle_gate": "configs/rules/vehicle_gate.yaml",
    "horse_riding": "configs/rules/horse_riding.yaml",
}
# every pipeline name main.py accepts today -> (class, rule file key)
TYPES = {
    "cashier_presence": (CashierPresencePipeline, "cashier_presence"),
    "restaurant_counter": (RestaurantCounterPipeline, "restaurant_counter"),
    "restaurant": (RestaurantCounterPipeline, "restaurant_counter"),
    "restaurant_table": (TableOccupancyPipeline, "restaurant_table"),
    "table_occupancy": (TableOccupancyPipeline, "restaurant_table"),
    "table_monitor": (TableOccupancyPipeline, "restaurant_table"),
    "vehicle_gate": (VehicleGatePipeline, "vehicle_gate"),
    "horse_riding": (HorseRidingPipeline, "horse_riding"),
    "horse_tracking": (HorseRidingPipeline, "horse_riding"),
    "horse": (HorseRidingPipeline, "horse_riding"),
}


def camera(pipeline_type, rule_key, **extra):
    return {"id": "cam_test", "name": "Test Cam", "pipeline": pipeline_type, "rule_config": RULES[rule_key], **extra}


@pytest.mark.parametrize("pipeline_type", TYPES)
def test_create_pipeline_picks_the_class(fake_yolo, pipeline_type):
    cls, rule_key = TYPES[pipeline_type]
    assert type(create_pipeline(camera(pipeline_type, rule_key), NxClient(mock_mode=True), "cpu")) is cls


def test_unknown_pipeline_type_returns_none(fake_yolo):
    assert create_pipeline({"id": "x", "pipeline": "nope"}, NxClient(mock_mode=True), "cpu") is None


@pytest.mark.parametrize("rule_key", RULES)
def test_pipeline_processes_frames(fake_yolo, rule_key):
    pipeline = create_pipeline(camera(rule_key, rule_key), NxClient(mock_mode=True), "cpu")
    frame = np.zeros((720, 1280, 3), np.uint8)
    for ts in (0, 200):
        out = pipeline.run(frame.copy(), ts)
        assert out.shape == frame.shape and out.dtype == np.uint8
    assert pipeline.latest_frame() is not None


def test_every_enabled_example_camera_builds(fake_yolo):
    cams = yaml.safe_load((ENGINE_DIR / "configs/cameras.yaml.example").read_text(encoding="utf-8"))["cameras"]
    for cam in cams:
        if cam.get("enabled", True):
            assert create_pipeline(cam, NxClient(mock_mode=True), "cpu") is not None, cam["id"]


def test_gate_without_plate_model_runs_without_anpr(fake_yolo, monkeypatch, tmp_path):
    monkeypatch.setenv("ZOO_MODELS_DIR", str(tmp_path))  # empty folder: the plate model is missing
    cam = camera("vehicle_gate", "vehicle_gate",
                 rules={"anpr": {"enabled": True, "model_path": "missing/license_plate_detector.onnx"}})
    pipeline = create_pipeline(cam, NxClient(mock_mode=True), "cpu")
    assert pipeline.anpr_enabled is False
    frame = np.zeros((720, 1280, 3), np.uint8)
    assert pipeline.run(frame, 0).shape == frame.shape
