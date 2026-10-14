"""The EngineCamera the API sends, as one JSON fixture shared with the API's e2e test
(packages/contracts/fixtures/engine-camera.json): if either side changes the shape, both tests fail."""

import json
from pathlib import Path

from core.camera_config import CameraConfig

FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures" / "engine-camera.json"


def test_engine_parses_the_shared_fixture():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    config = CameraConfig.from_api(fixture["engineCamera"])

    assert config.id == "cam_fixture_gate"
    assert config.use_case == "vehicle_gate"
    assert config.source_url == "rtsp://fixture:fixturepw@10.1.2.3:554/sub"
    assert config.target_fps == 4
    assert config.model_path == "yolo26s.onnx"
    assert config.imgsz == (384, 640)
    assert config.nx_camera_id == "nx-fixture-gate"
    assert config.settings["tripwire"]["start"] == fixture["settings"]["tripwire"]["start"]


def test_the_fixture_is_one_camera_in_the_shape_the_api_takes():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert set(fixture) == {"camera", "settings", "engineCamera"}
    # a sub stream the engine is told to read, with a main stream behind it
    assert fixture["camera"]["inferenceStream"] == "SUB"
    assert fixture["camera"]["subStreamUrl"] == fixture["engineCamera"]["sourceUrl"]
    assert fixture["camera"]["mainStreamUrl"] != fixture["engineCamera"]["sourceUrl"]
