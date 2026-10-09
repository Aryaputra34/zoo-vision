import json
import re

import numpy as np
import pytest
from core.messages import (
    ContractError,
    event_message,
    interval_close_message,
    interval_open_message,
    metric_message,
    validate,
)
from tests.conftest import ENGINE_DIR

CONTRACTS = ENGINE_DIR.parent.parent / "packages" / "contracts" / "usecases"


@pytest.mark.parametrize("path", sorted(CONTRACTS.glob("*/examples/messages/valid/*.json")),
                         ids=lambda p: f"{p.parts[-5]}/{p.name}")
def test_valid_contract_examples_pass(path):
    validate(json.loads(path.read_text(encoding="utf-8")))


@pytest.mark.parametrize("path", sorted(CONTRACTS.glob("*/examples/messages/invalid/*.json")),
                         ids=lambda p: f"{p.parts[-5]}/{p.name}")
def test_invalid_contract_examples_fail(path):
    with pytest.raises(ContractError):
        validate(json.loads(path.read_text(encoding="utf-8")))


def test_event_message_converts_numpy_scalars():
    m = event_message("cam_gate_entry_01", "vehicle_gate", "vehicle_crossing", {
        "direction": "ENTRY", "vehicleType": "car", "plate": "B 1234 XYZ", "plateValid": np.bool_(True),
        "ocrConfidence": np.float32(0.5), "trackerId": np.int64(7)}, time_ms=1_760_000_000_123)
    validate(m)
    assert json.loads(json.dumps(m))["data"]["trackerId"] == 7
    assert re.fullmatch(r"evt_[0-9a-f]{32}", m["id"]) and m["time"] == "2025-10-09T08:53:20.123Z"
    assert m["schemaVersion"] == 1 and m["configVersion"] is None


def test_unknown_type_and_bad_data_are_rejected():
    with pytest.raises(ContractError):
        validate(event_message("cam_x", "horse_riding", "horse_jump", {}))
    with pytest.raises(ContractError):
        validate(event_message("cam_x", "horse_riding", "horse_crossing", {"direction": "SIDEWAYS", "trackerId": 1}))


def test_metric_minute_must_be_whole():
    validate(metric_message("cam_x", "horse_riding", "active_horses", 120_000, 2.5))
    with pytest.raises(ContractError):
        validate(metric_message("cam_x", "horse_riding", "active_horses", 120_500, 2.5))


def test_unknown_metric_and_unknown_use_case_are_rejected():
    with pytest.raises(ContractError):
        validate(metric_message("cam_x", "horse_riding", "occupancy", 120_000, 1))
    with pytest.raises(ContractError):
        validate(metric_message("cam_x", "horse_riding", "__class__", 120_000, 1))
    with pytest.raises(ContractError):
        validate(metric_message("cam_x", "zebra", "x", 120_000, 1))


def test_schema_version_and_null_camera_rules():
    m = event_message("cam_x", "horse_riding", "horse_crossing", {"direction": "RETURN", "trackerId": 1})
    validate(m)
    with pytest.raises(ContractError):
        validate({**m, "schemaVersion": 2})
    with pytest.raises(ContractError):
        validate({**m, "cameraId": None})
    validate(event_message(None, "system", "events_dropped", {"engineGroup": "g", "count": 3}))


def test_data_types_are_strict():
    with pytest.raises(ContractError):
        validate(event_message(None, "system", "events_dropped", {"engineGroup": "g", "count": "3"}))


def test_interval_open_requires_fields():
    ok = interval_open_message("cam_t", "restaurant_table", "table_session", None, {"tableName": "T1"})
    validate(ok)
    assert re.fullmatch(r"ses_[0-9a-f]{32}", ok["sessionId"])
    with pytest.raises(ContractError):
        validate(interval_open_message("cam_t", "restaurant_table", "table_session", None, {}))


def test_interval_close_data_is_a_partial():
    sid = "ses_" + "a" * 32
    validate(interval_close_message("cam_t", "restaurant_table", "table_session", sid, {}))
    validate(interval_close_message("cam_t", "restaurant_table", "table_session", sid, None))
    validate(interval_close_message("cam_t", "restaurant_table", "table_session", sid, {"tableName": "T1"}))
    with pytest.raises(ContractError):
        validate(interval_close_message("cam_t", "restaurant_table", "table_session", sid, {"nope": 1}))
    with pytest.raises(ContractError):
        validate(interval_close_message("cam_t", "restaurant_table", "table_session", sid, {"tableName": 5}))


def test_non_finite_numbers_are_rejected():
    with pytest.raises(ContractError):
        validate(metric_message("cam_x", "horse_riding", "active_horses", 120_000, float("nan")))
    with pytest.raises(ContractError):
        validate(event_message("cam_x", "vehicle_gate", "vehicle_crossing", {
            "direction": "ENTRY", "vehicleType": "car", "plate": "B 1", "plateValid": True,
            "ocrConfidence": float("inf"), "trackerId": 1}))
