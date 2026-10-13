"""Supervisor: reconcile against the API's snapshot, debounced and periodic syncs, the stall watchdog."""

import threading
import time

import pytest
from conftest import camera_threads, cfg, opened_tables, people_in, sessions, table_dict, wait_until
from core.camera_config import ApiError
from core.supervisor import Supervisor
from usecases.restaurant_table.pipeline import TableOccupancyPipeline


class _Snapshot(list):
    skipped_ids: frozenset = frozenset()


class FakeApi:
    """cameras() returns `configs` (and `skipped` as the ids of malformed entries), or raises ApiError(error) while
    `error` is set. Records the time of each call."""

    def __init__(self, configs=(), error=None):
        self.configs = list(configs)
        self.skipped: set[str] = set()
        self.error = error
        self.times: list[float] = []

    def cameras(self):
        self.times.append(time.monotonic())
        if self.error:
            raise ApiError(self.error)
        snapshot = _Snapshot(self.configs)
        snapshot.skipped_ids = frozenset(self.skipped)
        return snapshot

    @property
    def calls(self) -> int:
        return len(self.times)


@pytest.fixture
def make_sup(deps, fake_yolo):
    made = []

    def make(api, **kwargs):
        sup = Supervisor(api, deps, **kwargs)
        made.append(sup)
        return sup

    yield make
    fake_yolo.gate.set()
    fake_yolo.load_gate.set()
    for sup in made:
        sup.shutdown()
    assert wait_until(lambda: camera_threads() == [])


@pytest.fixture
def run_sup(make_sup):
    """Runs Supervisor.run in a thread; at teardown (before make_sup's shutdown) stops it and joins it."""
    runs = []

    def start(sup):
        stop = threading.Event()
        thread = threading.Thread(target=sup.run, args=(stop,), name="supervisor-test", daemon=True)
        thread.start()
        runs.append((stop, thread))
        return stop

    yield start
    for stop, thread in runs:
        stop.set()
        thread.join(5)
        assert not thread.is_alive()


def recorder(sup_ref: list, stopped: list):
    """An on_stop that records each camera id, and whether the camera was still in `workers` at that moment."""
    def on_stop(camera_id):
        stopped.append(camera_id)
        if camera_id in sup_ref[0].workers:
            stopped.append(f"{camera_id} still listed")
    return on_stop


def test_reconcile_starts_new_stops_removed_and_updates_the_rest(make_sup, fake_yolo, stream):
    fake_yolo.boxes = people_in("T1", "T2")
    stopped, ref = [], []
    sup = make_sup(FakeApi(), on_stop=recorder(ref, stopped))
    ref.append(sup)
    sup.reconcile([cfg(id="a"), cfg(id="b")])
    assert set(sup.workers) == {"a", "b"}
    a = sup.workers["a"]
    assert wait_until(lambda: opened_tables(stream, "a") == opened_tables(stream, "b") == {"T1", "T2"})

    sup.reconcile([cfg(id="a", version=2, settings=table_dict("T1", "T2", confidence_threshold=0.3)), cfg(id="c")])
    assert set(sup.workers) == {"a", "c"} and sup.workers["a"] is a and stopped == ["b"]
    b_closes = sessions(stream, "interval_close", "b")
    assert len(b_closes) == 2 and {m["endReason"] for m in b_closes} == {"config_change"}
    assert wait_until(lambda: a.applied_version == 2 and sup.workers["c"].state == "running")
    assert set(sup.pipelines()) == {"a", "c"} and sup.pipelines()["a"] is a.pipeline

    sup.shutdown()
    assert sorted(stopped) == ["a", "b", "c"]
    assert {m["endReason"] for m in sessions(stream, "interval_close", "a")} == {"engine_stop"}


def test_sync_failure_keeps_running_cameras(make_sup, streams, caplog):
    api = FakeApi([cfg(id="a")])
    sup = make_sup(api)
    assert sup.sync() is True
    a = sup.workers["a"]
    assert wait_until(lambda: a.state == "running")
    api.error = "connection refused"
    assert sup.sync() is False and sup.sync() is False
    assert sup.workers == {"a": a} and a.state == "running" and streams.stopped() == 0
    assert caplog.text.count("connection refused") == 1  # logged once per outage
    api.error = None
    assert sup.sync() is True and sup.workers == {"a": a}


def test_first_sync_failure_starts_nothing_and_a_later_sync_starts_cameras(make_sup, run_sup):
    api = FakeApi([cfg(id="a")], error="503 Service Unavailable")
    sup = make_sup(api, resync_sec=0.2)
    run_sup(sup)
    assert wait_until(lambda: api.calls >= 1)
    assert sup.workers == {}
    api.error = None
    assert wait_until(lambda: "a" in sup.workers and sup.workers["a"].state == "running")


def test_failed_sync_is_retried_before_the_resync_period(make_sup, run_sup):
    api = FakeApi([cfg(id="a")], error="503 Service Unavailable")
    sup = make_sup(api, resync_sec=60.0)
    run_sup(sup)
    assert wait_until(lambda: api.calls >= 1)
    api.error = None
    assert wait_until(lambda: "a" in sup.workers)  # the first retry comes 1 s after the failure


def test_requests_inside_the_debounce_window_cause_one_sync(make_sup, run_sup):
    api = FakeApi([cfg(id="a")])
    sup = make_sup(api, debounce_sec=0.2)
    run_sup(sup)
    assert wait_until(lambda: api.calls == 1)  # the sync at start
    requested = time.monotonic()
    for _ in range(5):
        sup.request_sync()
    assert wait_until(lambda: api.calls == 2)
    assert api.times[1] - requested >= 0.199
    assert not wait_until(lambda: api.calls > 2, timeout=0.5)  # and no other sync follows


def test_resync_runs_without_a_request(make_sup, run_sup):
    api = FakeApi([cfg(id="a")])
    sup = make_sup(api, resync_sec=0.2)
    run_sup(sup)
    assert wait_until(lambda: api.calls >= 3)


def test_a_slow_stop_does_not_hold_up_the_other_cameras(make_sup, fake_yolo):
    stopped, ref = [], []
    sup = make_sup(FakeApi(), on_stop=recorder(ref, stopped))
    ref.append(sup)
    b = cfg(id="b", model_path="b.onnx")
    sup.reconcile([b])
    assert wait_until(lambda: sup.workers["b"].state == "running")
    fake_yolo.load_gate.clear()
    sup.reconcile([b, cfg(id="a", model_path="a.onnx")])
    a = sup.workers["a"]
    assert wait_until(lambda: fake_yolo.load_started == 2)  # a's thread is in its first model load: its stop waits

    reconciled = threading.Event()

    def remove_a_update_b_add_c():  # c shares b's model, which is loaded: it needs no load
        sup.reconcile([cfg(id="b", model_path="b.onnx", version=2, settings=table_dict("T1")),
                       cfg(id="c", model_path="b.onnx")])
        reconciled.set()

    thread = threading.Thread(target=remove_a_update_b_add_c, daemon=True)
    thread.start()
    assert wait_until(lambda: sup.workers["b"].applied_version == 2 and "c" in sup.workers
                      and sup.workers["c"].applied_version == 1)
    assert "a" not in sup.workers and a.state != "stopped" and stopped == [] and not reconciled.is_set()
    checker = threading.Thread(target=sup.check_stalls, daemon=True)  # the lock is free while a stops
    checker.start()
    checker.join(2)
    assert not checker.is_alive()

    fake_yolo.load_gate.set()
    assert wait_until(reconciled.is_set)
    thread.join(5)
    assert stopped == ["a"] and a.state == "stopped"


def test_stalled_worker_is_replaced(make_sup, fake_yolo, streams, stream, monkeypatch):
    fake_yolo.boxes = people_in("T1")
    streams.silent = {"dead"}  # a stream that never connects
    broken = threading.Event()
    process_frame = TableOccupancyPipeline.process_frame

    def breakable(self, frame, timestamp_ms):
        if broken.is_set():
            raise RuntimeError("stuck")
        return process_frame(self, frame, timestamp_ms)

    monkeypatch.setattr(TableOccupancyPipeline, "process_frame", breakable)
    stopped, ref = [], []
    sup = make_sup(FakeApi(), stall_sec=0.3, on_stop=recorder(ref, stopped))
    ref.append(sup)
    sup.reconcile([cfg(id="a"), cfg(id="dead")])
    old, dead = sup.workers["a"], sup.workers["dead"]
    assert wait_until(lambda: opened_tables(stream, "a") == {"T1"})
    broken.set()  # from now on every frame raises

    def replaced():
        sup.check_stalls()
        return sup.workers["a"] is not old

    assert wait_until(replaced)
    new = sup.workers["a"]
    assert new.restarts == 1 and old.state == "stopped" and stopped == ["a"]
    assert sup.workers["dead"] is dead and (dead.state, dead.restarts) == ("starting", 0)  # never restarted
    assert [m["endReason"] for m in sessions(stream, "interval_close", "a")] == ["engine_stop"]
    assert wait_until(lambda: new.pipeline is not None and new.applied_version == 1)


def test_a_restart_keeps_running_the_applied_version_when_the_newest_was_rejected(make_sup, stream, monkeypatch):
    broken = threading.Event()
    process_frame = TableOccupancyPipeline.process_frame

    def breakable(self, frame, timestamp_ms):
        if broken.is_set():
            raise RuntimeError("stuck")
        return process_frame(self, frame, timestamp_ms)

    monkeypatch.setattr(TableOccupancyPipeline, "process_frame", breakable)
    sup = make_sup(FakeApi(), stall_sec=0.3)
    sup.reconcile([cfg(id="a")])
    old = sup.workers["a"]
    assert wait_until(lambda: old.state == "running")
    bad = table_dict("T1")
    bad["tables"][0]["polygon"] = [[0, 0], [1, 0]]
    sup.reconcile([cfg(id="a", version=2, settings=bad, name="Renamed")])
    assert old.config_error.startswith("v2 rejected: ")
    broken.set()

    def replaced():
        sup.check_stalls()
        return sup.workers["a"] is not old

    assert wait_until(replaced)
    new = sup.workers["a"]
    assert wait_until(lambda: new.applied_version == 1 and new.pipeline is not None)
    assert new.config.version == 2 and new.pipeline.camera_name == "Renamed"
    assert new.config_error.startswith("v2 rejected: ")
    assert len([m for m in stream.sent if m["message"] == "event" and m["type"] == "config_rejected"]) == 1


def test_a_worker_whose_thread_died_is_restarted(make_sup, stream, monkeypatch):
    from core.worker import CameraWorker

    sup = make_sup(FakeApi(), stall_sec=0.3)
    sup.reconcile([cfg(id="a")])
    old = sup.workers["a"]
    assert wait_until(lambda: old.state == "running")
    frame_done = CameraWorker._frame_done

    def dying(self):
        if self is old:
            raise RuntimeError("a bug outside the pipeline call")
        frame_done(self)

    monkeypatch.setattr(CameraWorker, "_frame_done", dying)
    assert wait_until(lambda: old.state == "stopped")  # the thread ended without a stop()

    def replaced():
        sup.check_stalls()
        return sup.workers["a"] is not old

    assert wait_until(replaced)
    new = sup.workers["a"]
    assert new.restarts == 1 and wait_until(lambda: new.state == "running" and new.applied_version == 1)


def test_a_malformed_entry_leaves_its_camera_as_it_is(make_sup, streams):
    api = FakeApi([cfg(id="a"), cfg(id="b")])
    sup = make_sup(api)
    assert sup.sync()
    a = sup.workers["a"]
    assert wait_until(lambda: a.state == "running")
    api.configs, api.skipped = [cfg(id="b")], {"a"}  # a's entry did not parse
    assert sup.sync()
    assert sup.workers["a"] is a and a.state == "running" and streams.stopped() == 0
    api.skipped = set()  # a is gone from the snapshot
    assert sup.sync()
    assert "a" not in sup.workers and a.state == "stopped"


def test_before_the_first_answer_retries_stay_short(make_sup, run_sup, monkeypatch):
    monkeypatch.setattr("core.supervisor.RETRY_MIN_S", 0.05)
    monkeypatch.setattr("core.supervisor.FIRST_SYNC_RETRY_MAX_S", 0.2, raising=False)
    api = FakeApi([cfg(id="a")], error="connection refused")  # the API is not up yet at first boot
    sup = make_sup(api, resync_sec=60.0, debounce_sec=0.01)
    run_sup(sup)
    assert wait_until(lambda: api.calls >= 7, timeout=3.0)
    gaps = [b - a for a, b in zip(api.times, api.times[1:])]
    assert max(gaps[:6]) < 0.35  # doubling stops at 0.2 s while the API never answered
    api.error = None
    assert wait_until(lambda: "a" in sup.workers)
    api.error = "503 Service Unavailable"  # a later outage backs off up to resync_sec
    calls = api.calls
    sup.request_sync()
    assert wait_until(lambda: api.calls >= calls + 5, timeout=3.0)
    gaps = [b - a for a, b in zip(api.times[calls:], api.times[calls + 1:])]
    assert max(gaps) >= 0.35
