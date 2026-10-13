import torch
import numpy as np
from conftest import example_dict, example_settings, make_pipeline
from core.messages import validate
from core.settings import parse_settings

FRAME = np.zeros((720, 1280, 3), np.uint8)
NONE = torch.zeros((0, 6))


def box(x1, y1, x2, y2, cls=0.0, conf=0.9):
    return torch.tensor([[x1, y1, x2, y2, conf, cls]])


def settings_from(use_case, **changes):
    """The example settings with top-level keys replaced, parsed leniently."""
    d = example_dict(use_case)
    d.update(changes)
    return parse_settings(use_case, d, strict=False)


def walk(p, fake_yolo, start_ts, ys, make_box):
    """Runs one frame per y; returns the next timestamp."""
    ts = start_ts
    for y in ys:
        fake_yolo.boxes = make_box(y)
        p.run(FRAME.copy(), ts)
        ts += 1000
    return ts


def horse_at(y2):
    return box(600, y2 - 160, 680, y2, cls=17.0)


def car_at(y2):
    return box(560, y2 - 140, 760, y2, cls=2.0)


def person_at(y2):
    return box(600, y2 - 160, 680, y2)


def line(y):
    return {"start": [0.9, y], "end": [0.1, y]}


def wire(y):
    return {"enabled": True, **line(y)}


def of_type(stream, kind):
    return [m for m in stream.sent if m["message"] == "event" and m["type"] == kind]


def test_moving_the_horse_tripwire_keeps_counts_and_tracks(fake_yolo, stream):
    p = make_pipeline("horse_riding", settings_from("horse_riding", tripwire=wire(0.6)), stream=stream)
    p.config_version = 1
    ts = walk(p, fake_yolo, 1000, range(360, 560, 20), horse_at)  # crosses y=432
    assert p.line_zone.in_count == 1
    tracker, line = p.tracker, p.line_zone
    p.apply_config(settings_from("horse_riding", tripwire=wire(0.8)), 2)
    assert p.config_version == 2
    walk(p, fake_yolo, ts, range(560, 720, 20), horse_at)  # crosses y=576
    assert p.line_zone.in_count == 2
    assert p.line_zone is not line  # the line was rebuilt, its counts were carried over
    assert p.tracker is tracker
    assert [m["configVersion"] for m in of_type(stream, "horse_crossing")] == [1, 2]


def test_horse_tripwire_disabled_drops_the_line(fake_yolo):
    p = make_pipeline("horse_riding", settings_from("horse_riding", tripwire=wire(0.6)))
    p.run(FRAME.copy(), 1000)
    off = {"enabled": False, "start": [0.1, 0.6], "end": [0.9, 0.6]}
    p.apply_config(settings_from("horse_riding", tripwire=off), 2)
    p.run(FRAME.copy(), 2000)
    assert p.line_zone is None and not p.tripwire_enabled
    assert p.live["departures"] is None


def test_tracker_tuning_builds_a_new_tracker(fake_yolo):
    p = make_pipeline("horse_riding")
    tracker = p.tracker
    p.apply_config(example_settings("horse_riding").model_copy(update={"lost_track_buffer": 90}), 2)
    assert p.tracker is not tracker
    p.run(FRAME.copy(), 1000)


def test_smoothing_and_trace_changes_rebuild_only_those(fake_yolo):
    p = make_pipeline("horse_riding")
    tracker, smoother, trace = p.tracker, p.smoother, p.trace_annotator
    p.apply_config(example_settings("horse_riding").model_copy(update={"trace_length": 20}), 2)
    assert p.tracker is tracker and p.smoother is smoother and p.trace_annotator is not trace
    trace = p.trace_annotator
    p.apply_config(p.settings.model_copy(update={"smoothing_frames": 8}), 3)
    assert p.tracker is tracker and p.smoother is not smoother and p.trace_annotator is trace


def test_thresholds_apply_without_rebuilding(fake_yolo):
    p = make_pipeline("horse_riding")
    tracker = p.tracker
    p.run(FRAME.copy(), 1000)
    assert fake_yolo.kwargs[-1]["conf"] == 0.25
    p.apply_config(example_settings("horse_riding").model_copy(update={"confidence_threshold": 0.5}), 2)
    p.run(FRAME.copy(), 2000)
    assert fake_yolo.kwargs[-1]["conf"] == 0.5
    assert p.tracker is tracker


def test_gate_tripwire_move_keeps_counts(fake_yolo, stream):
    p = make_pipeline("vehicle_gate", settings_from("vehicle_gate", tripwire=line(0.6)), stream=stream)
    p.config_version = 1
    ts = walk(p, fake_yolo, 1000, range(360, 560, 20), car_at)
    assert p.line_zone.in_count + p.line_zone.out_count == 1
    tracker = p.tracker
    p.apply_config(settings_from("vehicle_gate", tripwire=line(0.8)), 2)
    walk(p, fake_yolo, ts, range(560, 720, 20), car_at)
    assert p.line_zone.in_count + p.line_zone.out_count == 2
    assert p.tracker is tracker
    assert [m["configVersion"] for m in of_type(stream, "vehicle_crossing")] == [1, 2]


def test_gate_tracker_tuning_builds_a_new_tracker(fake_yolo):
    p = make_pipeline("vehicle_gate")
    tracker = p.tracker
    p.apply_config(example_settings("vehicle_gate").model_copy(update={"matching_thresh": 0.8}), 2)
    assert p.tracker is not tracker


def test_gate_anpr_change_rebuilds_the_engine_and_keeps_the_plate_cache(fake_yolo):
    p = make_pipeline("vehicle_gate")
    assert p.anpr_engine is None
    p.vehicle_plates[1] = {"plate_text": "B 1234 XY"}
    anpr = example_dict("vehicle_gate")["anpr"] | {"enabled": True}
    p.apply_config(settings_from("vehicle_gate", anpr=anpr), 2)
    assert p.anpr_engine is not None and p.anpr_enabled
    engine = p.anpr_engine
    p.apply_config(settings_from("vehicle_gate", anpr=anpr | {"min_plate_confidence": 0.4}), 3)
    assert p.anpr_engine is not engine
    assert p.vehicle_plates == {1: {"plate_text": "B 1234 XY"}}
    p.apply_config(settings_from("vehicle_gate"), 4)
    assert p.anpr_engine is None and not p.anpr_enabled


def test_cashier_zone_move_keeps_the_open_desk_interval(fake_yolo, stream):
    p = make_pipeline("cashier_presence", stream=stream)
    for ts in range(40_000, 51_000, 1000):
        p.run(FRAME.copy(), ts)
    session, seen = p.desk_session, p.last_presence_time
    assert session and [m["kind"] for m in stream.sent if m["message"] == "interval_open"] == ["desk_unattended"]
    zone = p.clerk_zone
    moved = [[0.1, 0.5], [0.3, 0.5], [0.3, 0.9], [0.1, 0.9]]
    p.apply_config(settings_from("cashier_presence", clerk_zone=moved), 2)
    for ts in (51_000, 52_000):
        p.run(FRAME.copy(), ts)
    assert p.clerk_zone is not zone and tuple(p.clerk_zone.polygon[0]) == (128, 360)
    assert p.desk_session == session and p.last_presence_time == seen
    assert [m["message"] for m in stream.sent if m["message"].startswith("interval")] == ["interval_open"]


def test_cashier_visitor_zone_can_be_removed(fake_yolo):
    p = make_pipeline("cashier_presence")
    p.run(FRAME.copy(), 40_000)
    assert p.visitor_zone is not None
    p.apply_config(p.settings.model_copy(update={"visitor_zone": None}), 2)
    p.run(FRAME.copy(), 41_000)
    assert p.visitor_zone is None and p.visitor_annotator is None and p.live["visitorCount"] == 0


T1 = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.5], [0.1, 0.5]]
T2 = [[0.6, 0.1], [0.9, 0.1], [0.9, 0.5], [0.6, 0.5]]
T3 = [[0.1, 0.6], [0.4, 0.6], [0.4, 0.95], [0.1, 0.95]]
P1 = (200, 100, 300, 300)
P2 = (800, 100, 900, 300)
P3 = (200, 450, 300, 650)


def tables(*specs):
    return [{"id": i, "name": f"Table {i}", "capacity": 4, "polygon": poly} for i, poly in specs]


def people(*boxes):
    return torch.tensor([[*b, 0.9, 0.0] for b in boxes]) if boxes else NONE


def table_settings(*specs):
    dwell = {"enabled": True, "min_occupied_sec": 0.0, "empty_debounce_sec": 2.0, "alert_dwell_sec": 3600.0}
    return settings_from("restaurant_table", tables=tables(*specs), dwell_time=dwell)


def table_messages(stream, message):
    return [m for m in stream.sent if m["message"] == message and m.get("kind") == "table_session"]


def test_restaurant_table_change(fake_yolo, stream):
    p = make_pipeline("restaurant_table", table_settings(("T1", T1), ("T2", T2)), stream=stream)
    p.config_version = 1
    fake_yolo.boxes = people(P1, P2)
    for ts in (1000, 2000):
        p.run(FRAME.copy(), ts)
    opened = {m["subjectId"]: m["sessionId"] for m in table_messages(stream, "interval_open")}
    assert set(opened) == {"T1", "T2"}
    zone_t1 = p.table_engine.tables[0]

    moved_t1 = [[0.1, 0.1], [0.45, 0.1], [0.45, 0.5], [0.1, 0.5]]
    p.apply_config(table_settings(("T1", moved_t1), ("T3", T3)), 2)
    closed = table_messages(stream, "interval_close")
    assert [(m["sessionId"], m["endReason"], m["configVersion"]) for m in closed] == [
        (opened["T2"], "config_change", 2)]
    assert p.table_engine.tables[0] is zone_t1 and [list(pt) for pt in zone_t1.raw_polygon] == moved_t1

    fake_yolo.boxes = people(P1, P3)  # T3 is occupied while it warms up (empty_debounce_sec 2)
    for ts in (3000, 4000):
        p.run(FRAME.copy(), ts)
    assert {m["subjectId"] for m in table_messages(stream, "interval_open")} == {"T1", "T2"}
    t3 = p.table_engine.tables[1]
    assert t3.status == "OCCUPIED"  # the state follows the detections, silently
    fake_yolo.boxes = people(P1)
    for ts in (5000, 6000, 7000):
        p.run(FRAME.copy(), ts)
    assert t3.status == "EMPTY"
    assert len(table_messages(stream, "interval_close")) == 1  # nothing closed for T3, T1 still open


def test_restaurant_table_scalars_apply_live(fake_yolo):
    p = make_pipeline("restaurant_table")
    p.apply_config(example_settings("restaurant_table").model_copy(
        update={"show_summary_card": False, "show_person_boxes": True}), 2)
    assert p.table_engine.show_summary_card is False and p.show_boxes is True


def occupy_example_tables(p, fake_yolo):
    fake_yolo.boxes = people((330, 380, 430, 640), (750, 180, 850, 320))  # in T1 and T7 of the example
    for ts in range(1000, 8000, 1000):  # the example's tables need 5 s of presence
        p.run(FRAME.copy(), ts)


def test_disabling_table_monitoring_closes_every_session(fake_yolo, stream):
    p = make_pipeline("restaurant_counter", stream=stream)
    occupy_example_tables(p, fake_yolo)
    opened = {m["sessionId"] for m in table_messages(stream, "interval_open")}
    assert len(opened) == 2
    settings = example_settings("restaurant_counter")
    off = settings.table_monitoring.model_copy(update={"enabled": False})
    p.apply_config(settings.model_copy(update={"table_monitoring": off}), 2)
    closed = table_messages(stream, "interval_close")
    assert {m["sessionId"] for m in closed} == opened and {m["endReason"] for m in closed} == {"config_change"}
    assert p.table_engine is None
    p.run(FRAME.copy(), 9000)
    assert "tables" not in p.live


def test_enabling_table_monitoring_warms_up_every_table(fake_yolo, stream):
    base = example_settings("restaurant_counter")
    quick = base.table_monitoring.dwell_time.model_copy(update={"min_occupied_sec": 0.0})
    base = base.model_copy(update={"table_monitoring": base.table_monitoring.model_copy(update={"dwell_time": quick})})
    off = base.table_monitoring.model_copy(update={"enabled": False})
    p = make_pipeline("restaurant_counter", base.model_copy(update={"table_monitoring": off}), stream=stream)
    assert p.table_engine is None
    p.apply_config(base, 2)
    assert p.table_engine is not None and len(p.table_engine.tables) == 15
    fake_yolo.boxes = people((330, 380, 430, 640))
    for ts in (1000, 2000):  # the example's debounce is 2 s: the warm-up ends at 3 s
        p.run(FRAME.copy(), ts)
    assert table_messages(stream, "interval_open") == []
    assert [t.table_id for t in p.table_engine.tables if t.status == "OCCUPIED"] == ["T1"]


def test_table_monitoring_change_keeps_table_state(fake_yolo, stream):
    p = make_pipeline("restaurant_counter", stream=stream)
    occupy_example_tables(p, fake_yolo)
    engine, zone = p.table_engine, p.table_engine.tables[0]
    settings = example_settings("restaurant_counter")
    p.apply_config(settings.model_copy(update={
        "table_monitoring": settings.table_monitoring.model_copy(update={"show_overlay": False})}), 2)
    assert p.table_engine is engine and engine.tables[0] is zone and engine.show_overlay is False
    assert zone.status == "OCCUPIED" and len(table_messages(stream, "interval_open")) == 2
    assert not table_messages(stream, "interval_close")


def test_counter_tripwire_move_keeps_line_counts(fake_yolo):
    p = make_pipeline("restaurant_counter", settings_from("restaurant_counter", mode="tripwire", tripwire=line(0.6)))
    ts = walk(p, fake_yolo, 1000, range(360, 560, 20), person_at)
    assert p.line_zone.in_count + p.line_zone.out_count == 1
    tracker = p.tracker
    p.apply_config(settings_from("restaurant_counter", mode="tripwire", tripwire=line(0.8)), 3)
    walk(p, fake_yolo, ts, range(560, 720, 20), person_at)
    assert p.line_zone.in_count + p.line_zone.out_count == 2
    assert p.tracker is tracker


def test_counter_dining_zone_change_rebuilds_the_zone(fake_yolo):
    p = make_pipeline("restaurant_counter")
    p.run(FRAME.copy(), 1000)
    zone = p.polygon_zone
    p.apply_config(settings_from("restaurant_counter", dining_zone=[[0, 0], [0.5, 0], [0.5, 1], [0, 1]]), 2)
    assert p.polygon_zone is None  # rebuilt from the frame shape at the next frame
    p.run(FRAME.copy(), 2000)
    assert p.polygon_zone is not zone and p.polygon_zone.polygon[:, 0].max() == 640


def test_counter_tracking_change_builds_a_new_tracker_and_smoother(fake_yolo):
    p = make_pipeline("restaurant_counter")
    assert p.tracker is None and p.smoother is None
    p.apply_config(settings_from("restaurant_counter", tracking_enabled=True), 2)
    assert p.tracker is not None and p.smoother is not None
    tracker = p.tracker
    p.apply_config(settings_from("restaurant_counter", tracking_enabled=True, lost_track_buffer=50), 3)
    assert p.tracker is not tracker
    p.run(FRAME.copy(), 1000)


def test_mode_change_resets_occupancy(fake_yolo):
    p = make_pipeline("restaurant_counter")
    fake_yolo.boxes = people((330, 380, 430, 640))
    for ts in (1000, 2000):
        p.run(FRAME.copy(), ts)
    assert p.current_occupancy == 1 and p.polygon_zone is not None and p.count_history
    engine = p.table_engine
    p.apply_config(settings_from("restaurant_counter", mode="tripwire"), 2)
    assert p.mode == "tripwire"
    assert (p.current_occupancy, p.raw_occupancy, len(p.count_history)) == (0, 0, 0)
    assert p.polygon_zone is None and p.line_zone is None and p.tracker is not None
    assert p.table_engine is engine
    p.run(FRAME.copy(), 3000)
    assert p.line_zone is not None and p.live["mode"] == "tripwire"


def test_set_model_swaps_the_detector_and_keeps_the_tracker(fake_yolo):
    p = make_pipeline("horse_riding")
    p.run(FRAME.copy(), 1000)
    tracker, old = p.tracker, p.model
    new = type(old)()
    new.names = {0: "person", 3: "horse"}
    assert p.set_model(new) is old
    assert p.model is new and p.tracker is tracker
    assert p.horse_class_ids == [3]
    p.run(FRAME.copy(), 2000)
    assert fake_yolo.kwargs[-1]["classes"] == [3]


def test_shutdown_reason_reaches_every_close(fake_yolo, stream):
    p = make_pipeline("restaurant_table", table_settings(("T1", T1), ("T2", T2)), stream=stream)
    fake_yolo.boxes = people(P1, P2)
    for ts in (1000, 2000):
        p.run(FRAME.copy(), ts)
    p.shutdown("config_change")
    closes = [m for m in stream.sent if m["message"] == "interval_close"]
    assert len(closes) == 2 and {m["endReason"] for m in closes} == {"config_change"}


def test_apply_config_messages_stay_valid(fake_yolo, stream):
    p = make_pipeline("cashier_presence", stream=stream)
    p.apply_config(example_settings("cashier_presence"), 5)
    p.open_interval("desk_unattended")
    validate(stream.sent[-1])
    assert stream.sent[-1]["configVersion"] == 5
