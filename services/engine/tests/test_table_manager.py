import numpy as np
import supervision as sv
from core.table_manager import TableOccupancyEngine

SHAPE = (720, 1280, 3)
POLY_A = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.5], [0.1, 0.5]]
POLY_B = [[0.6, 0.1], [0.9, 0.1], [0.9, 0.5], [0.6, 0.5]]
POLY_C = [[0.1, 0.6], [0.4, 0.6], [0.4, 0.95], [0.1, 0.95]]
PERSON_A = (200, 100, 300, 300)
PERSON_C = (200, 450, 300, 650)


def config(*tables, debounce=2.0, **extra):
    return {"dwell_time": {"enabled": True, "min_occupied_sec": 0.0, "empty_debounce_sec": debounce},
            "tables": [{"id": i, "name": f"Table {i}", "capacity": 4, "polygon": p} for i, p in tables], **extra}


def dets(*boxes):
    if not boxes:
        return sv.Detections.empty()
    return sv.Detections(xyxy=np.array(boxes, dtype=float), confidence=np.full(len(boxes), 0.9))


class Recorder:
    def __init__(self):
        self.events = []

    def __call__(self, event_type, data, severity):
        self.events.append((data["tableId"], data["status"]))


def test_reconfigure_keeps_state_by_id_and_returns_removed():
    engine = TableOccupancyEngine(config(("A", POLY_A), ("B", POLY_B)))
    engine.update(dets(PERSON_A), 1000, SHAPE)
    engine.update(dets(PERSON_A), 2000, SHAPE)
    zone_a = engine.tables[0]
    assert zone_a.status == "OCCUPIED" and zone_a.total_sessions_count == 1
    moved = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
    cfg = config(("A", moved), ("C", POLY_C), debounce=9.0, show_overlay=False)
    cfg["tables"][0].update(name="Renamed", capacity=8)
    assert engine.reconfigure(cfg) == ["B"]
    assert [t.table_id for t in engine.tables] == ["A", "C"]
    assert engine.tables[0] is zone_a
    assert (zone_a.name, zone_a.capacity, zone_a.raw_polygon) == ("Renamed", 8, moved)
    assert zone_a.pixel_polygon is None and zone_a.empty_debounce_sec == 9.0
    assert (zone_a.status, zone_a.total_sessions_count) == ("OCCUPIED", 1)
    assert engine.show_overlay is False and engine.empty_debounce_sec == 9.0
    engine.update(dets(PERSON_A), 3000, SHAPE)
    assert zone_a.pixel_polygon[1][0] == 640 and zone_a.current_dwell_sec == 2  # dwell kept counting from 1 s


def test_new_table_reports_no_transition_while_warming_up():
    rec = Recorder()
    engine = TableOccupancyEngine(config(("A", POLY_A)), rec)
    engine.reconfigure(config(("A", POLY_A), ("C", POLY_C)))
    for ts in (1000, 2000):  # the warm-up runs from the first update (1 s) to 3 s
        engine.update(dets(PERSON_C), ts, SHAPE)
    assert engine.tables[1].status == "OCCUPIED" and rec.events == []
    for ts in (3000, 4000, 5000):  # empty from 3 s: the debounce ends at 4 s, after the warm-up
        engine.update(dets(), ts, SHAPE)
    assert rec.events == [("C", "EMPTY")]


def test_a_warm_table_reports_the_transition_right_after_warm_up():
    rec = Recorder()
    engine = TableOccupancyEngine(config(("A", POLY_A)), rec)
    engine.reconfigure(config(("A", POLY_A), ("C", POLY_C), debounce=0.5))
    engine.update(dets(), 1000, SHAPE)  # warm-up ends at 1.5 s
    engine.update(dets(PERSON_C), 2000, SHAPE)
    assert rec.events == [("C", "OCCUPIED")]


def test_tables_at_construction_do_not_warm_up():
    rec = Recorder()
    engine = TableOccupancyEngine(config(("A", POLY_A)), rec)
    engine.update(dets(PERSON_A), 1000, SHAPE)
    assert rec.events == [("A", "OCCUPIED")]
