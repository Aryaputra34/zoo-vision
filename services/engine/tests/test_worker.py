"""Camera workers: config changes between frames, model loads off the frame loop, rejections, stop and stall."""

import logging

import pytest
from conftest import (FakeClock, camera_threads, cfg, example_dict, opened_tables, people_in, sessions, table_dict,
                      wait_until)
from core.camera_config import CameraConfig
from usecases.restaurant_table.pipeline import TableOccupancyPipeline

A, B, C = ("a.onnx", 1920), ("b.onnx", 1920), ("c.onnx", 1920)


def bad_settings() -> dict:
    d = table_dict("T1", "T2")
    d["tables"][0]["polygon"] = [[0, 0], [1, 0]]
    return d


def rejections(stream) -> list:
    return [m for m in stream.sent if m["message"] == "event" and m["type"] == "config_rejected"]


def running(w):
    return lambda: w.state == "running"


def entry(**over) -> dict:
    e = {
        "id": "cam1", "name": "Cam 1", "useCase": "restaurant_table", "version": 3, "schemaVersion": 1,
        "settings": {"model_name": "a.onnx"}, "sourceUrl": "rtsp://u:p@h/s", "targetFps": 5, "nxCameraId": None,
        "model": {"path": "a.onnx", "imgsz": [640, 640]},
    }
    e.update(over)
    return e


def test_camera_config_from_api():
    c = CameraConfig.from_api(entry())
    assert (c.id, c.name, c.use_case, c.version, c.target_fps) == ("cam1", "Cam 1", "restaurant_table", 3, 5)
    assert (c.source_url, c.model_path, c.imgsz, c.nx_camera_id) == ("rtsp://u:p@h/s", "a.onnx", (640, 640), None)
    assert c == CameraConfig.from_api(entry())  # compares by value
    assert CameraConfig.from_api(entry(model={"path": "a.onnx", "imgsz": 1280})).imgsz == 1280


@pytest.mark.parametrize("over", [
    {"version": "3"}, {"version": True}, {"version": 0}, {"settings": []}, {"targetFps": 0}, {"sourceUrl": ""},
    {"model": {"path": "a.onnx", "imgsz": [640]}}, {"model": {"imgsz": 640}}, {"nxCameraId": 5}, {"id": ""},
])
def test_camera_config_from_api_rejects_malformed_entries(over):
    with pytest.raises(ValueError) as e:
        CameraConfig.from_api(entry(**over))
    assert "u:p" not in str(e.value)


def test_new_version_applies_between_frames_on_the_same_pipeline(make_worker, fake_yolo, stream):
    fake_yolo.boxes = people_in("T1", "T2")
    w = make_worker()
    w.start()
    assert wait_until(lambda: w.state == "running" and opened_tables(stream) == {"T1", "T2"})
    pipeline = w.pipeline
    w.update(cfg(version=2, settings=table_dict("T1")))  # T2 is removed: its session closes at the change
    assert wait_until(lambda: w.applied_version == 2)
    assert w.pipeline is pipeline and pipeline.config_version == 2
    w.stop("engine_stop")  # closes T1 and flushes the metrics of the minute in progress

    subject = {m["sessionId"]: m["subjectId"] for m in sessions(stream, "interval_open")}
    assert [(subject[m["sessionId"]], m["endReason"], m["configVersion"]) for m in sessions(stream, "interval_close")] \
        == [("T2", "config_change", 2), ("T1", "engine_stop", 2)]
    versions = [m["configVersion"] for m in stream.sent if m["cameraId"] == "cam1"]
    first = versions.index(2)
    assert set(versions[:first]) == {1} and set(versions[first:]) == {2}


def test_source_change_restarts_only_the_stream(make_worker, streams, caplog):
    caplog.set_level(logging.DEBUG)
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    pipeline = w.pipeline
    w.update(cfg(source_url="rtsp://admin:s3cret@10.0.0.6/sub"))
    assert wait_until(lambda: streams.started() == 2 and streams.stopped() == 1)
    assert streams.made[0].stops == 1 and streams.made[1].source == "rtsp://admin:s3cret@10.0.0.6/sub"
    w.update(cfg(source_url="rtsp://admin:s3cret@10.0.0.6/sub", target_fps=2))
    assert wait_until(lambda: streams.started() == 3 and streams.stopped() == 2)
    assert streams.made[2].target_fps == 2 and streams.made[2].stops == 0
    last = w.last_frame_at
    assert wait_until(lambda: w.last_frame_at > last)  # frames keep coming, now from the third stream
    assert w.pipeline is pipeline and w.applied_version == 1
    assert "s3cret" not in caplog.text


def test_name_change_is_assigned_between_frames(make_worker, streams):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    pipeline = w.pipeline
    nx_id = "11111111-2222-3333-4444-555555555555"
    w.update(cfg(name="Front Booths", nx_camera_id=nx_id))
    assert wait_until(lambda: pipeline.camera_name == "Front Booths")
    assert pipeline.nx_camera_id == nx_id and w.pipeline is pipeline and streams.started() == 1


def test_use_case_change_rebuilds_and_closes_with_config_change(make_worker, fake_yolo, fake_pool, streams, stream):
    fake_yolo.boxes = people_in("T1", "T2")
    w = make_worker()
    w.start()
    assert wait_until(lambda: opened_tables(stream) == {"T1", "T2"})
    old = w.pipeline
    w.update(cfg(version=2, use_case="cashier_presence", settings=example_dict("cashier_presence")))
    assert wait_until(lambda: w.applied_version == 2)
    assert w.pipeline is not old and w.pipeline.use_case == "cashier_presence" and w.pipeline.config_version == 2
    closes = sessions(stream, "interval_close")
    assert len(closes) == 2
    assert {(m["useCase"], m["endReason"], m["configVersion"]) for m in closes} \
        == {("restaurant_table", "config_change", 1)}
    calls = len(fake_yolo.batches)
    assert wait_until(lambda: len(fake_yolo.batches) > calls)  # frames run on the new pipeline
    assert streams.started() == 1 and streams.stopped() == 0  # the stream is kept
    assert fake_pool.loaded() == [A]
    w.stop("engine_stop")
    assert fake_pool.loaded() == []  # the old pipeline's handle was released at the swap, the new one at stop


def test_invalid_version_keeps_the_previous_one_and_reports_once(make_worker, fake_pool, stream):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    pipeline = w.pipeline
    w.update(cfg(version=2, settings=bad_settings()))
    assert w.config_error.startswith("v2 rejected: /tables/0/polygon")
    assert w.applied_version == 1 and w.pipeline is pipeline and w.state == "running"
    w.update(cfg(version=2, settings=bad_settings()))
    w.update(cfg(version=2, settings=bad_settings(), model_path="b.onnx"))  # parsed again, rejected again
    assert w.config_error.startswith("v2 rejected: /tables/0/polygon")
    [event] = rejections(stream)
    assert (event["cameraId"], event["useCase"], event["severity"]) == ("cam1", "system", "warning")
    assert event["data"]["version"] == 2 and event["data"]["reason"].startswith("/tables/0/polygon: ")
    assert fake_pool.loaded() == [A]
    last = w.last_frame_at
    assert wait_until(lambda: w.last_frame_at > last)  # still running v1


def test_reasons_are_at_most_500_characters(make_worker, stream):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    w.update(cfg(version=2, settings={**table_dict("T1"), "x" * 900: 1}))
    assert w.config_error.startswith("v2 rejected: ") and len(w.config_error) <= 500
    [event] = rejections(stream)  # RecordingStream validates maxLength 500
    assert 0 < len(event["data"]["reason"]) <= 500


def test_new_camera_with_invalid_settings_is_in_error_without_a_stream(make_worker, fake_pool, streams, stream):
    w = make_worker(cfg(settings=bad_settings()))
    w.start()
    assert wait_until(lambda: w.state == "error")
    assert w.pipeline is None and w.applied_version is None and streams.made == []
    assert w.config_error.startswith("v1 rejected: /tables/0/polygon")
    assert len(rejections(stream)) == 1 and fake_pool.loaded() == []
    w.update(cfg(version=2))  # a valid version starts the camera
    assert wait_until(lambda: w.state == "running" and w.applied_version == 2)
    assert w.config_error is None and streams.started() == 1


def test_an_invalid_version_leaves_a_loading_camera_starting(make_worker, fake_yolo, stream):
    fake_yolo.load_gate.clear()
    w = make_worker()
    w.start()  # v1's model is loading
    w.update(cfg(version=2, settings=bad_settings()))
    assert w.state == "starting" and w.config_error.startswith("v2 rejected: ")
    fake_yolo.load_gate.set()
    assert wait_until(lambda: w.state == "running" and w.applied_version == 1)
    assert w.config_error.startswith("v2 rejected: ") and len(rejections(stream)) == 1


def test_model_change_swaps_after_loading_and_releases_the_old_model(make_worker, fake_yolo, fake_pool, monkeypatch):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    assert fake_pool.loaded() == [A]
    pipeline, old_model = w.pipeline, w.pipeline.model
    loaded_at_release = []
    release = fake_pool.release

    def recording_release(detector):
        loaded_at_release.append(sorted(fake_pool.loaded()))
        release(detector)

    monkeypatch.setattr(fake_pool, "release", recording_release)
    fake_yolo.load_gate.clear()
    w.update(cfg(version=2, model_path="b.onnx"))
    assert fake_yolo.loads == 1 and w.applied_version == 1  # update() returned without waiting for the load
    fake_yolo.load_gate.set()
    assert wait_until(lambda: w.applied_version == 2 and fake_pool.loaded() == [B])
    assert loaded_at_release == [[A, B]]  # A was released once B had loaded and taken its place
    assert w.pipeline is pipeline and w.pipeline.model is not old_model


def test_superseded_model_load_is_discarded(make_worker, fake_yolo, fake_pool, monkeypatch):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    applied = []
    apply_config = w.pipeline.apply_config

    def recording_apply(settings, version):
        applied.append(version)
        apply_config(settings, version)

    w.pipeline.apply_config = recording_apply
    released = []
    release = fake_pool.release

    def recording_release(detector):
        release(detector)
        released.append(detector)

    monkeypatch.setattr(fake_pool, "release", recording_release)
    fake_yolo.load_gate.clear()
    w.update(cfg(version=2, model_path="b.onnx"))
    assert wait_until(lambda: fake_yolo.load_started == 2)  # B is loading (A was the first)
    w.update(cfg(version=3, model_path="c.onnx"))
    assert wait_until(lambda: fake_yolo.load_started == 3)  # and so is C
    assert w.applied_version == 1
    fake_yolo.load_gate.set()
    assert wait_until(lambda: w.applied_version == 3 and len(released) == 2)  # A after the swap, and B unused
    assert fake_yolo.loads == 3 and fake_pool.loaded() == [C] and applied == [3]  # B loaded, never ran, released


def test_model_load_error_keeps_the_running_model(make_worker, fake_yolo, fake_pool, stream):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    w.update(cfg(version=2, model_path="missing.onnx"))
    assert wait_until(lambda: len(rejections(stream)) == 1)
    assert w.config_error.startswith("v2 rejected: /model_name: ")
    assert rejections(stream)[0]["data"]["version"] == 2
    assert w.applied_version == 1 and w.state == "running" and fake_pool.loaded() == [A]
    calls = len(fake_yolo.batches)
    assert wait_until(lambda: len(fake_yolo.batches) > calls + 2)  # still running frames on A


def test_stop_closes_intervals_with_the_reason(make_worker, fake_yolo, fake_pool, streams, stream):
    fake_yolo.boxes = people_in("T1", "T2")
    w = make_worker()
    w.start()
    assert wait_until(lambda: opened_tables(stream) == {"T1", "T2"})
    w.stop("engine_stop")
    closes = sessions(stream, "interval_close")
    assert len(closes) == 2 and {m["endReason"] for m in closes} == {"engine_stop"}
    assert w.state == "stopped" and streams.stopped() == 1 and fake_pool.loaded() == []
    assert camera_threads() == []


def test_stop_during_a_model_load_releases_the_late_detector(make_worker, fake_yolo, fake_pool):
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    fake_yolo.load_gate.clear()
    w.update(cfg(version=2, model_path="b.onnx"))
    assert wait_until(lambda: fake_yolo.load_started == 2)  # B is loading
    w.stop("engine_stop")  # returns at once: it doesn't wait for the loader
    assert camera_threads() == ["cam-cam1-load"]
    assert w.state == "stopped" and w.applied_version == 1 and fake_pool.loaded() == []
    fake_yolo.load_gate.set()
    assert wait_until(lambda: camera_threads() == [])  # the loader got B, found the worker stopped, released B
    assert fake_yolo.loads == 2 and fake_pool.loaded() == []


def test_stalled_only_when_frames_arrive_but_none_is_processed(make_worker, streams, monkeypatch):
    clock = FakeClock()
    t0 = clock.t
    streams.clock = clock
    streams.silent = {"dead"}
    process_frame = TableOccupancyPipeline.process_frame

    def raising_for_bad(self, frame, timestamp_ms):
        if self.camera_id == "bad":
            raise RuntimeError("boom")
        return process_frame(self, frame, timestamp_ms)

    monkeypatch.setattr(TableOccupancyPipeline, "process_frame", raising_for_bad)
    ok, bad, dead = (make_worker(cfg(id=i), clock=clock) for i in ("ok", "bad", "dead"))
    for w in (ok, bad, dead):
        w.start()
    # every worker is polling its stream (the stall check's own reads come later)
    assert wait_until(lambda: len(streams.made) == 3 and all(s.reads for s in streams.made))
    assert wait_until(lambda: ok.last_frame_at == t0)
    assert not any(w.stalled(t0 + 29) for w in (ok, bad, dead))  # started less than 30 s ago

    clock.t = t0 + 31
    assert wait_until(lambda: bad.stalled(t0 + 31))  # frames arrive, none is processed
    assert wait_until(lambda: ok.last_frame_at == t0 + 31)
    assert not ok.stalled(t0 + 31)  # frames are processed
    assert not dead.stalled(t0 + 31)  # no frame ever arrived
    assert (ok.state, bad.state, dead.state) == ("running", "starting", "starting")


def test_the_stall_check_counts_from_the_stream_start_and_started_at_stays_the_worker_start(
        make_worker, fake_yolo, streams, monkeypatch):
    clock = FakeClock()
    t0 = clock.t
    streams.clock = clock

    def raising(self, frame, timestamp_ms):
        raise RuntimeError("boom")

    monkeypatch.setattr(TableOccupancyPipeline, "process_frame", raising)
    fake_yolo.load_gate.clear()
    w = make_worker(clock=clock)
    w.start()
    assert wait_until(lambda: fake_yolo.load_started == 1)
    clock.t = t0 + 100  # a slow first model load
    fake_yolo.load_gate.set()
    assert wait_until(lambda: len(streams.made) == 1 and streams.made[0].reads > 0)
    assert (w.started_at, w.stream_started_at) == (t0, t0 + 100)  # the status expiry anchor stays the worker start
    assert not w.stalled(t0 + 120)  # the worker started 120 s ago, its stream only 20 s ago
    clock.t = t0 + 131
    assert wait_until(lambda: w.stalled(t0 + 131))


def test_a_stream_back_after_a_long_outage_is_not_a_stall(make_worker, fake_yolo, streams):
    clock = FakeClock()
    t0 = clock.t
    streams.clock = clock
    streams.silent_sources = {"missing.mp4"}
    w = make_worker(clock=clock)
    w.start()
    assert wait_until(lambda: w.last_frame_at == t0)
    w.update(cfg(source_url="missing.mp4"))  # a source that never delivers: nothing is processed meanwhile
    assert wait_until(lambda: len(streams.made) == 2 and streams.made[1].reads > 0)
    clock.t = t0 + 100
    calls = len(fake_yolo.batches)
    fake_yolo.gate.clear()  # the first frame of the next stream stays in the model
    w.update(cfg(source_url="rtsp://10.0.0.6/back"))
    assert wait_until(lambda: len(fake_yolo.batches) > calls)  # the new stream delivers; its frame is in the model
    clock.t = t0 + 101
    assert not w.stalled(t0 + 101)  # the last processed frame is 101 s old, but this stream delivers since t0 + 100
    clock.t = t0 + 130
    assert not w.stalled(t0 + 130)
    clock.t = t0 + 131
    assert wait_until(lambda: w.stalled(t0 + 131))  # the new stream delivers and nothing was processed for 31 s
    fake_yolo.gate.set()
    clock.t = t0 + 132
    assert wait_until(lambda: w.last_frame_at == t0 + 132)
    assert not w.stalled(t0 + 132)


def test_a_pipeline_failing_on_every_frame_of_a_slow_stream_is_a_stall(make_worker, streams, monkeypatch):
    clock = FakeClock()
    t0 = clock.t
    streams.clock = clock
    streams.period = 1.5  # a new frame every 1.5 s: after each error the worker finds no new frame for a while
    failures = []

    def raising(self, frame, timestamp_ms):
        failures.append(timestamp_ms)
        raise RuntimeError("boom")

    monkeypatch.setattr(TableOccupancyPipeline, "process_frame", raising)
    w = make_worker(clock=clock)
    w.start()
    assert wait_until(lambda: len(failures) == 1)
    assert wait_until(lambda: streams.made[0].reads > 3)  # the worker polls the stream between two frames
    clock.t = t0 + 31
    assert wait_until(lambda: w.stalled(t0 + 31), timeout=5.0)  # waiting between failing frames is no rest


def test_a_reconnect_within_the_same_stream_is_not_a_stall(make_worker, fake_yolo, streams):
    clock = FakeClock()
    t0 = clock.t
    streams.clock = clock
    w = make_worker(clock=clock)
    w.start()
    assert wait_until(lambda: w.last_frame_at == t0)
    stream = streams.made[0]
    stream.deliver = False  # the camera drops off; the stream reconnects by itself
    reads = stream.reads
    assert wait_until(lambda: stream.reads > reads + 3)
    clock.t = t0 + 100
    reads = stream.reads
    assert wait_until(lambda: stream.reads > reads + 3)  # the worker kept polling the silent stream
    calls = len(fake_yolo.batches)
    fake_yolo.gate.clear()
    stream.deliver = True
    assert wait_until(lambda: len(fake_yolo.batches) > calls)
    clock.t = t0 + 101
    assert not w.stalled(t0 + 101)  # the worker waited for frames until t0 + 100: it is not behind
    clock.t = t0 + 131
    assert wait_until(lambda: w.stalled(t0 + 131))  # but its frames are processed no longer


def test_a_model_that_failed_to_load_is_retried_when_its_config_comes_again(make_worker, fake_yolo, streams, stream):
    fake_yolo.unavailable = {"late.onnx"}
    w = make_worker(cfg(model_path="late.onnx"))
    w.start()
    assert wait_until(lambda: w.state == "error")
    assert w.config_error.startswith("v1 rejected: /model_name: could not load model late.onnx")
    w.update(cfg(model_path="late.onnx"))  # the periodic resync brings the same config: the file is still missing
    assert wait_until(lambda: fake_yolo.load_started == 2 and camera_threads() == ["cam-cam1"])
    assert w.state == "error" and w.config_error.startswith("v1 rejected: ")
    fake_yolo.unavailable = set()  # the file is there now
    w.update(cfg(model_path="late.onnx"))
    assert wait_until(lambda: w.state == "running" and w.applied_version == 1)
    assert w.config_error is None and streams.started() == 1
    assert len(rejections(stream)) == 1  # one config_rejected event for the version, however often it is retried


def test_a_running_camera_retries_a_new_model_that_failed_to_load(make_worker, fake_yolo, fake_pool, stream):
    fake_yolo.unavailable = {"late.onnx"}
    w = make_worker()
    w.start()
    assert wait_until(running(w))
    w.update(cfg(version=2, model_path="late.onnx"))
    assert wait_until(lambda: len(rejections(stream)) == 1)
    assert w.applied_version == 1 and w.config_error.startswith("v2 rejected: /model_name: ")
    fake_yolo.unavailable = set()
    w.update(cfg(version=2, model_path="late.onnx"))  # the resync
    assert wait_until(lambda: w.applied_version == 2)
    assert w.config_error is None and len(rejections(stream)) == 1 and fake_pool.loaded() == [("late.onnx", 1920)]


def test_a_stream_that_cannot_be_started_is_retried(make_worker, streams, monkeypatch):
    monkeypatch.setattr("core.worker.STREAM_RETRY_MIN_S", 0.05, raising=False)
    streams.fail_starts = 2
    w = make_worker()
    w.start()
    assert wait_until(running(w))  # the third attempt worked
    assert len(streams.made) == 1
    streams.fail_starts = 1
    w.update(cfg(source_url="rtsp://10.0.0.6/sub"))  # a swap whose first attempt fails
    assert wait_until(lambda: len(streams.made) == 2 and streams.made[0].stops == 1)
    assert streams.made[1].source == "rtsp://10.0.0.6/sub"
