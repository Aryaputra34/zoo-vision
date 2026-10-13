import json
from pathlib import Path

import jsonschema
import pytest
import yaml

from import_yaml_config import (
    camera_payload, effective_rules, import_cameras, mask_url, normalize_use_case, source_type, to_settings,
)

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / "services/engine"
SCHEMAS = REPO / "packages/contracts/generated/schemas/usecases"

EXAMPLE = yaml.safe_load((ENGINE / "configs/cameras.yaml.example").read_text(encoding="utf-8"))["cameras"]
# the example file has no horse or table camera; these two cover those transforms
EXTRA = [{"id": "cam_pony_01", "name": "Pony", "pipeline": "horse", "source": "sample_data/kuda.mp4",
          "rule_config": "configs/rules/horse_riding.yaml"},
         {"id": "cam_tables_01", "name": "Tables", "pipeline": "table_monitor", "source": "sample_data/restoran.mp4",
          "rule_config": "configs/rules/restaurant_table.yaml"}]


def _convert(cam):
    uc = normalize_use_case(cam["pipeline"])
    schema = json.loads((SCHEMAS / uc / "settings.json").read_text(encoding="utf-8"))
    settings, dropped = to_settings(uc, effective_rules(cam, ENGINE), schema)
    return uc, schema, settings, dropped


def settings_for(cam):
    return _convert(cam)[2]


def dropped_for(cam_id):
    return _convert(next(c for c in EXAMPLE if c["id"] == cam_id))[3]


@pytest.mark.parametrize("cam", EXAMPLE + EXTRA, ids=lambda c: c["id"])
def test_every_example_camera_validates(cam):
    _, schema, settings, _ = _convert(cam)
    jsonschema.Draft202012Validator(schema).validate(settings)


def test_inline_list_roi_does_not_replace_the_rule_files_clerk_zone():
    cam = next(c for c in EXAMPLE if c["id"] == "cam_cashier_02")
    rule = yaml.safe_load((ENGINE / cam["rule_config"]).read_text(encoding="utf-8"))
    assert settings_for(cam)["clerk_zone"] == rule["clerk_zone"]   # matches what the engine runs today


def test_dropped_keys_are_reported():
    assert dropped_for("cam_gate_entry_01") == ["/anpr/regex_pattern", "/entry_direction", "/rule_name", "/vehicle_classes"]
    assert dropped_for("cam_cashier_01") == ["/rule_name", "/target_class"]


def test_aliases_and_source_types():
    assert normalize_use_case("horse") == "horse_riding" and normalize_use_case("table_monitor") == "restaurant_table"
    assert source_type("rtsp://127.0.0.1:8554/cam_x") == "MEDIAMTX"
    assert source_type("rtsp://u:p@10.0.0.5/s") == "RTSP"
    assert source_type("sample_data/cars.mp4") == "FILE"
    with pytest.raises(ValueError):
        normalize_use_case("nope")


def test_mask_url_hides_credentials():
    assert mask_url("rtsp://admin:secret@10.0.0.5:554/s1") == "rtsp://***@10.0.0.5:554/s1"
    assert mask_url("sample_data/cars.mp4") == "sample_data/cars.mp4"
    assert mask_url("rtsp://u:p@ss@10.0.0.5:554/s1") == "rtsp://***@10.0.0.5:554/s1"
    slash = mask_url("rtsp://u:a/b@h/x")
    assert "a/b" not in slash and "u:a" not in slash and slash == "rtsp://***@h/x"
    assert mask_url("rtsp://h/x?token=abc") == "rtsp://h/x?***"
    assert mask_url("rtsp://10.0.0.5:554/s1") == "rtsp://10.0.0.5:554/s1"


def test_import_exit_code(capsys):
    responses = iter([(201, ""), (409, ""), (400, '{"errors":[]}')])
    assert import_cameras([{"id": "a"}, {"id": "b"}, {"id": "c"}], lambda p: next(responses)) == 1
    out = capsys.readouterr().out
    assert "created: a" in out and "exists, skipped: b" in out and "FAILED: c" in out and '{"errors":[]}' in out


def test_import_masks_urls_and_succeeds_when_all_ok(capsys):
    p = {"id": "a", "mainStreamUrl": "rtsp://u:secret@h/x"}
    assert import_cameras([p], lambda _: (201, "")) == 0
    out = capsys.readouterr().out
    assert "secret" not in out and "rtsp://***@h/x" in out


def test_rule_precedence_file_then_inline_rules_then_roi(tmp_path):
    (tmp_path / "r.yaml").write_text("a: 1\nb: 1\nzone_polygon: [[0, 0]]\n", encoding="utf-8")
    cam = {"rule_config": "r.yaml", "rules": {"b": 2}, "roi": {"zone_polygon": [[1, 1]]}}
    assert effective_rules(cam, tmp_path) == {"a": 1, "b": 2, "zone_polygon": [[1, 1]]}
    # a bare dict ROI becomes zone_polygon; a list ROI fills all three polygon keys
    assert effective_rules({"roi": {"x": 1}}, tmp_path) == {"zone_polygon": {"x": 1}}
    assert set(effective_rules({"roi": [[0, 0]]}, tmp_path)) == {"zone_polygon", "dining_zone", "roi_polygon"}
    assert effective_rules({"rule_config": "missing.yaml"}, tmp_path) == {}


def test_transforms_and_payload():
    schema = json.loads((SCHEMAS / "cashier_presence" / "settings.json").read_text(encoding="utf-8"))
    settings, _ = to_settings("cashier_presence", {"zone_polygon": [[0, 0], [1, 0], [1, 1]]}, schema)
    assert settings["clerk_zone"] == [[0, 0], [1, 0], [1, 1]]
    settings, _ = to_settings("cashier_presence", {}, schema)
    assert settings["clerk_zone"] == [[0.33, 0.46], [0.72, 0.46], [0.72, 1.0], [0.33, 1.0]]

    horse = json.loads((SCHEMAS / "horse_riding" / "settings.json").read_text(encoding="utf-8"))
    assert "roi_polygon" not in to_settings("horse_riding", {"roi_polygon": []}, horse)[0]

    cam = {"id": "cam_x", "name": "X", "source": "rtsp://127.0.0.1:8554/cam_x",
           "nx_camera_id": "00000000-0000-0000-0000-000000000000"}
    p = camera_payload(cam, "horse_riding", {})
    assert p["nxCameraId"] is None and p["targetFps"] == 10 and p["sourceType"] == "MEDIAMTX"
    assert p["enabled"] is True and p["note"] == "imported from cameras.yaml"


def test_table_monitoring_is_lifted():
    schema = json.loads((SCHEMAS / "restaurant_table" / "settings.json").read_text(encoding="utf-8"))
    settings, _ = to_settings("restaurant_table", {"imgsz": 640, "table_monitoring": {"tables": []}}, schema)
    assert "table_monitoring" not in settings and settings["tables"] == [] and settings["imgsz"] == 640
