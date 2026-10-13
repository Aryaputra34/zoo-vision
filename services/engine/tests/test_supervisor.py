"""Supervisor: reconcile against the API's snapshot, debounced and periodic syncs, the stall watchdog."""

import threading
import time

import pytest
from conftest import camera_threads, cfg, opened_tables, people_in, sessions, table_dict, wait_until
from core.camera_config import ApiError
from core.supervisor import Supervisor
from usecases.restaurant_table.pipeline import TableOccupancyPipeline


class FakeApi:
    """cameras() returns `configs`, or raises ApiError(error) while `error` is set. Records the time of each call."""

    def __init__(self, configs=(), error=None):
        self.configs = list(configs)
        self.error = error
        self.times: list[float] = []

    def cameras(self):
        self.times.append(time.monotonic())
        if self.error:
            raise ApiError(self.error)
        return list(self.configs)

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
    assert camera_threads() == []


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


def test_reconcile_starts_new_stops_removed_and_updates_the_rest(make_sup, fake_yolo, stream):
    fake_yolo.boxes = people_in("T1", "T2")
    stopped = []
    sup = make_sup(FakeApi(), on_stop=stopped.append)
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
    stopped = []
    sup = make_sup(FakeApi(), stall_sec=0.3, on_stop=stopped.append)
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
