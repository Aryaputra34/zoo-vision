import logging
from pathlib import Path

import pytest
import redis
from conftest import FakeYOLO
from core.camera_config import ApiError
from core.model_jobs import ModelJobs, convert_to_onnx, validate_model
from conftest import wait_until


@pytest.fixture(autouse=True)
def _reset():
    FakeYOLO.reset()


class RecordingApi:
    def __init__(self, fail=False):
        self.validations, self.conversions, self.fail = [], [], fail

    def report_validation(self, model_id, body):
        self.validations.append((model_id, body))
        if self.fail:
            raise ApiError("HTTP 500")

    def report_conversion(self, model_id, body):
        self.conversions.append((model_id, body))
        if self.fail:
            raise ApiError("HTTP 500")


def make_jobs(tmp_path, api=None):
    api = api or RecordingApi()
    return ModelJobs(None, api, str(tmp_path), "cpu", loader=FakeYOLO), api


def test_validate_reports_classes_and_latency():
    result = validate_model("registry/1.onnx", "cpu", loader=FakeYOLO)
    assert result["ok"] is True and result["device"] == "cpu"
    assert result["classNames"][0] == "person" and len(result["classNames"]) == 80
    assert result["latencyMs"] >= 0
    assert FakeYOLO.batches == [1] * 4  # one warm-up and three timed calls


def test_validate_reports_a_load_error():
    result = validate_model("missing.onnx", "cpu", loader=FakeYOLO)
    assert result["ok"] is False and result["error"].startswith("FileNotFoundError")


def test_validate_truncates_a_long_error():
    def loader(path):
        raise RuntimeError("x" * 900)

    assert len(validate_model("a.onnx", "cpu", loader=loader)["error"]) == 500


def test_convert_moves_the_export_to_out_path_and_hashes_it(tmp_path):
    src, out = tmp_path / "m.pt", tmp_path / "registry" / "7.onnx"
    src.write_bytes(b"weights")
    result = convert_to_onnx(str(src), str(out), [640, 480], loader=FakeYOLO)
    import hashlib

    assert result == {"ok": True, "sha256": hashlib.sha256(b"fake onnx").hexdigest()}
    assert out.read_bytes() == b"fake onnx" and not (tmp_path / "m.onnx").exists()
    assert FakeYOLO.exports == [dict(format="onnx", imgsz=[640, 480], dynamic=True, half=False, opset=19,
                                     simplify=True)]


def test_convert_never_touches_files_beside_the_source(tmp_path):
    src, sibling, out = tmp_path / "m.pt", tmp_path / "m.onnx", tmp_path / "registry" / "7.onnx"
    src.write_bytes(b"weights")
    sibling.write_bytes(b"the original onnx")
    result = convert_to_onnx(str(src), str(out), 640, loader=FakeYOLO, work_dir=str(tmp_path))
    assert result["ok"] is True and out.read_bytes() == b"fake onnx"
    assert sibling.read_bytes() == b"the original onnx" and src.read_bytes() == b"weights"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["m.onnx", "m.pt", "registry"]


def test_convert_failure_leaves_nothing_behind(tmp_path):
    src, out = tmp_path / "missing.pt", tmp_path / "7.onnx"
    src.write_bytes(b"weights")
    result = convert_to_onnx(str(src), str(out), 640, loader=FakeYOLO, work_dir=str(tmp_path))
    assert result["ok"] is False and "FileNotFoundError" in result["error"]
    assert sorted(p.name for p in tmp_path.rglob("*")) == ["missing.pt"]


def test_handle_routes_jobs_and_reports(tmp_path):
    jobs, api = make_jobs(tmp_path)
    jobs.handle({"type": "validate", "modelId": "m1", "path": "registry/1.onnx"})
    [(model_id, body)] = api.validations
    assert model_id == "m1" and body["ok"] is True and body["device"] == "cpu"

    (tmp_path / "a.pt").write_bytes(b"weights")
    jobs.handle({"type": "convert", "modelId": "m1", "targetId": "m2", "path": "a.pt",
                 "outPath": "registry/m2.onnx", "imgsz": 640})
    [(target, body)] = api.conversions
    assert target == "m2" and body["ok"] is True and body["path"] == "registry/m2.onnx" and len(body["sha256"]) == 64
    assert (tmp_path / "registry" / "m2.onnx").is_file()


@pytest.mark.parametrize("path", ["../outside.onnx", "registry/../../outside.onnx", str(Path("/abs/x.onnx").resolve())])
def test_paths_outside_models_dir_are_refused(tmp_path, path):
    jobs, api = make_jobs(tmp_path)
    jobs.handle({"type": "validate", "modelId": "m1", "path": path})
    jobs.handle({"type": "convert", "modelId": "m1", "targetId": "m2", "path": "a.pt", "outPath": path, "imgsz": 640})
    jobs.handle({"type": "convert", "modelId": "m1", "targetId": "m3", "path": path, "outPath": "o.onnx", "imgsz": 640})
    assert FakeYOLO.load_started == 0
    assert [b["ok"] for _, b in api.validations + api.conversions] == [False] * 3
    assert all("outside" in b["error"] for _, b in api.validations + api.conversions)


def test_bad_jobs_are_dropped(tmp_path, caplog):
    jobs, api = make_jobs(tmp_path)
    with caplog.at_level(logging.WARNING):
        jobs.handle("nope")
        jobs.handle({"type": "x"})
        jobs.handle({"type": "validate", "modelId": "m1"})
    assert api.validations == api.conversions == []
    assert len(caplog.records) == 3


def test_a_failed_report_is_logged(tmp_path, caplog):
    jobs, api = make_jobs(tmp_path, RecordingApi(fail=True))
    with caplog.at_level(logging.WARNING):
        jobs.handle({"type": "validate", "modelId": "m1", "path": "a.onnx"})
    assert "HTTP 500" in caplog.text


def test_the_loop_survives_a_redis_outage(tmp_path, monkeypatch):
    monkeypatch.setattr("core.model_jobs.BACKOFF_START_S", 0.01)

    class Client:
        def __init__(self):
            self.calls = 0

        def brpop(self, queue, timeout):
            self.calls += 1
            if self.calls <= 2:
                raise redis.ConnectionError("down")
            if self.calls == 3:
                return queue, b'{"type": "validate", "modelId": "m1", "path": "a.onnx"}'
            return None

    api = RecordingApi()
    jobs = ModelJobs(Client(), api, str(tmp_path), "cpu", loader=FakeYOLO)
    jobs.start()
    try:
        assert wait_until(lambda: len(api.validations) == 1)
        assert jobs.is_alive()
    finally:
        jobs.stop()
        jobs.join(5)
    assert not jobs.is_alive()
