import numpy as np
import pytest
import torch
from core.snapshot_store import SnapshotStore
from main import create_pipeline
from nx_integration.nx_client import NxClient
from test_pipeline_wiring import camera

FRAME = np.zeros((720, 1280, 3), np.uint8)
CLERK = torch.tensor([[600.0, 480.0, 680.0, 600.0, 0.9, 0.0]])  # inside clerk_zone on 1280x720


def table_change(status):
    return {"tableId": "T1", "tableName": "Table 1", "oldStatus": "", "status": status, "dwellSec": 0, "timestampMs": 1}


def table_pipeline(rule_key, stream):
    p = create_pipeline(camera(rule_key, rule_key), NxClient(mock_mode=True), "cpu")
    p.events = stream
    return p


@pytest.mark.parametrize("rule_key", ["restaurant_table", "restaurant_counter"])
def test_table_state_changes_become_one_session(fake_yolo, stream, rule_key):
    p = table_pipeline(rule_key, stream)
    p._handle_table_event("table_state_change", table_change("OCCUPIED"), "info")
    p._handle_table_event("table_state_change", table_change("EMPTY"), "info")
    opened, closed = stream.sent
    assert (opened["message"], opened["kind"], opened["subjectId"], opened["data"]) == (
        "interval_open", "table_session", "T1", {"tableName": "Table 1"})
    assert (closed["message"], closed["sessionId"], closed["endReason"]) == (
        "interval_close", opened["sessionId"], "ended")
    assert not [m for m in stream.sent if m["message"] == "event"]  # no table_state_change events remain


def test_cashier_desk_unattended_interval_and_alert_snapshot(fake_yolo, stream, tmp_path, monkeypatch):
    p = create_pipeline(camera("cashier_presence", "cashier_presence"), NxClient(mock_mode=True), "cpu")
    p.events = stream
    p.snapshots = SnapshotStore(tmp_path, retention_days=0)
    # Start at 40 s: the alert's 30 s debounce counts from stream time 0, and ts 0 would fall back to the wall clock.
    for ts in range(40_000, 52_000, 1000):
        monkeypatch.setattr(fake_yolo, "boxes", CLERK if ts in (40_000, 51_000) else torch.zeros((0, 6)))
        p.run(FRAME.copy(), ts)
    kinds = [(m["message"], m.get("kind") or m.get("type")) for m in stream.sent if m["message"] != "metric"]
    assert kinds == [("interval_open", "desk_unattended"), ("event", "cashier_unattended"),
                     ("interval_close", "desk_unattended")]
    alert = next(m for m in stream.sent if m.get("type") == "cashier_unattended")
    assert (tmp_path / alert["snapshotPath"]).is_file()
    assert "snapshot" not in alert["data"]


def test_status_fields_become_minute_metrics(fake_yolo, stream):
    p = table_pipeline("restaurant_table", stream)
    for ts in (0, 200):
        p.run(FRAME.copy(), ts)
    p.shutdown()
    assert {m["name"] for m in stream.sent if m["message"] == "metric"} == {"occupied_tables", "table_occupancy_pct"}


def test_shutdown_closes_open_intervals(fake_yolo, stream):
    p = table_pipeline("restaurant_table", stream)
    p._handle_table_event("table_state_change", table_change("OCCUPIED"), "info")
    p.shutdown()
    last = stream.sent[-1]
    assert (last["message"], last["endReason"], last["sessionId"]) == ("interval_close", "engine_stop", stream.sent[0]["sessionId"])


def test_intervals_work_without_a_stream(fake_yolo):
    p = create_pipeline(camera("restaurant_table", "restaurant_table"), NxClient(mock_mode=True), "cpu")
    sid = p.open_interval("table_session", "T1", {"tableName": "Table 1"})
    assert sid
    p.close_interval(sid)
    p.close_interval("unknown")  # no-op
    p.shutdown()
