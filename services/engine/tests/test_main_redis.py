import os
import threading
import time
import uuid

import pytest
import redis
from core.env import load_env
from main import run
from test_api_client import FakeApi, entry

from conftest import FakeYOLO, example_dict

pytestmark = pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs REDIS_URL")

TOKEN = "t" * 40


def poll(cond, timeout):
    """The value `cond` returns once it is truthy, else None after `timeout` seconds."""
    deadline = time.monotonic() + timeout
    while True:
        value = cond()
        if value:
            return value
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.05)


def test_one_file_camera_runs_and_reports_its_version(tmp_path, fake_yolo):
    camera_id = f"cam_main_test_{uuid.uuid4().hex[:6]}"
    (tmp_path / "x.onnx").write_bytes(b"")
    settings = example_dict("vehicle_gate")
    settings["anpr"] = {**settings.get("anpr", {}), "enabled": False}

    def camera(version):
        return entry(camera_id, useCase="vehicle_gate", version=version, settings=settings,
                     sourceUrl="sample_data/cars.mp4", targetFps=2, model={"path": "x.onnx", "imgsz": 640})

    api = FakeApi()
    api.serve([camera(1)])
    env = load_env({
        "REDIS_URL": os.environ["REDIS_URL"], "API_URL": api.url, "ENGINE_TOKEN": TOKEN,
        "ENGINE_GROUP": "main-test", "ZOO_MODELS_DIR": str(tmp_path), "SNAPSHOT_DIR": str(tmp_path / "snaps"),
    })
    r = redis.Redis.from_url(os.environ["REDIS_URL"])
    stop = threading.Event()
    thread = threading.Thread(target=run, args=(env, stop), kwargs={"loader": FakeYOLO}, name="engine-run")
    key = f"cam:{camera_id}:status"
    try:
        thread.start()
        status = poll(lambda: (r.hget(key, "appliedVersion") == b"1" and r.hget(key, "state") == b"running"), 10)
        assert status, f"no running status for version 1: {r.hgetall(key)}"
        assert r.hget(key, "engineGroup") == b"main-test"
        assert poll(lambda: r.exists(f"cam:{camera_id}:frame"), 10)

        api.serve([camera(2)])
        r.publish("cfg:changed", f'{{"cameraId": "{camera_id}", "version": 2}}')
        assert poll(lambda: r.hget(key, "appliedVersion") == b"2", 2), f"version 2 not applied: {r.hgetall(key)}"
        assert all(h["Authorization"] == f"Bearer {TOKEN}" for _, _, h, _ in api.requests)
    finally:
        stop.set()
        thread.join(15)
        api.close()
        r.delete(key, f"cam:{camera_id}:frame")
        r.close()
    assert not thread.is_alive(), "run() did not return within 15 s of the stop"
    assert [t.name for t in threading.enumerate() if t.name.startswith(("cam-", "status-", "config-"))] == []
