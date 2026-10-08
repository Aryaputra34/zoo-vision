import json
import os

import yaml
from conftest import ENGINE_DIR


def test_every_model_named_in_configs_is_in_the_manifest():
    manifest = {m["file"] for m in json.loads((ENGINE_DIR / "models/manifest.json").read_text())["models"]}
    named = set()
    for rule_file in (ENGINE_DIR / "configs/rules").glob("*.yaml"):
        rules = yaml.safe_load(rule_file.read_text(encoding="utf-8")) or {}
        if "model_name" in rules:
            named.add(rules["model_name"])
        if "model_path" in rules.get("anpr", {}):
            named.add(os.path.basename(rules["anpr"]["model_path"]))
    for cam in yaml.safe_load((ENGINE_DIR / "configs/cameras.yaml.example").read_text(encoding="utf-8"))["cameras"]:
        if "model_name" in (cam.get("rules") or {}):
            named.add(cam["rules"]["model_name"])
    assert named - manifest == set()
