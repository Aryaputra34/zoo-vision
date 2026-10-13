import numpy as np
import pytest
from conftest import example_dict, make_pipeline, table_change
from contracts.registry import REGISTRY
from core.base_pipeline import BasePipeline
from usecases import _index, pipeline_class, use_cases

FRAME = np.zeros((720, 1280, 3), np.uint8)
ASSIGNABLE = sorted(u for u, c in REGISTRY.items() if c.settings)


def test_registry_covers_every_assignable_use_case():
    assert use_cases() == ASSIGNABLE


@pytest.mark.parametrize("use_case", ASSIGNABLE)
def test_pipeline_processes_frames(fake_yolo, use_case):
    p = make_pipeline(use_case)
    assert p.use_case == use_case
    for ts in (0, 200):
        out = p.run(FRAME.copy(), ts)
        assert out.shape == FRAME.shape and out.dtype == np.uint8
    assert p.latest_frame() is not None
    assert fake_yolo.kwargs[-1]["imgsz"] == p.settings.imgsz  # the model call reads the typed settings


def test_gate_without_plate_model_runs_without_anpr(fake_yolo, monkeypatch, tmp_path):
    monkeypatch.setenv("ZOO_MODELS_DIR", str(tmp_path))  # empty folder: the plate model is missing
    settings = example_dict("vehicle_gate")
    settings["anpr"] = {"enabled": True, "model_path": "missing/license_plate_detector.onnx"}
    pipeline = make_pipeline("vehicle_gate", settings)
    assert pipeline.anpr_enabled is False
    assert pipeline.run(FRAME, 0).shape == FRAME.shape


def test_pipeline_class_maps_each_use_case_and_rejects_unknown_ones():
    for use_case in ASSIGNABLE:
        assert pipeline_class(use_case).use_case == use_case
    with pytest.raises(KeyError):
        pipeline_class("nope")


def test_two_classes_for_one_use_case_are_an_error():
    class A(BasePipeline):
        use_case = "dup"

    class B(BasePipeline):
        use_case = "dup"

    with pytest.raises(ValueError, match="dup"):
        _index([A, B])


def test_messages_carry_the_config_version_the_config_version(fake_yolo, stream):
    p = make_pipeline("restaurant_table", stream=stream)
    p.config_version = 4
    p._handle_table_event("table_state_change", table_change("OCCUPIED"), "info")
    assert stream.sent[0]["configVersion"] == 4


def test_every_message_kind_carries_the_config_version(fake_yolo, stream):
    p = make_pipeline("cashier_presence", stream=stream)
    p.config_version = 7
    p.emit("cashier_unattended", {"absentSec": 12}, "warning")
    p.run(FRAME.copy(), 40_000)  # sends the event raised above
    p.open_interval("desk_unattended")
    p.emit_status({"clerkCount": 1, "visitorCount": 0})
    p.shutdown()  # closes the interval and flushes the minute metrics
    assert {m["message"] for m in stream.sent} == {"event", "interval_open", "interval_close", "metric"}
    assert {m["configVersion"] for m in stream.sent} == {7}
