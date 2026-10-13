# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml>=6", "requests>=2.31"]
# ///
"""One-off import of the engine's cameras.yaml (+ rule files) into the API as cameras.

Each camera gets the settings the engine would run today: rule file, then inline `rules`, then inline
`roi`, merged as BasePipeline does. Keys the use case's settings schema doesn't define are dropped and
reported as JSON pointers. Stream URLs are masked in all output; the token is never printed.

    export ZOO_API_TOKEN=zv_...      # a SUPERADMIN API token (not needed for --dry-run)
    uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml
    uv run tools/import_yaml_config.py --cameras services/engine/configs/cameras.yaml.example --dry-run
    uv run tools/import_yaml_config.py --cameras cameras.yaml --api http://127.0.0.1:3001

Exit code: 0 when every camera was created or already existed, 1 when any failed, 2 when the token is
missing.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import yaml

REPO = Path(__file__).resolve().parents[1]
NO_NX_ID = "00000000-0000-0000-0000-000000000000"
DEFAULT_CLERK_ZONE = [[0.33, 0.46], [0.72, 0.46], [0.72, 1.0], [0.33, 1.0]]
HTTP_TIMEOUT_S = 15

# main.create_pipeline's pipeline names -> contract use case ids
ALIASES = {
    "cashier_presence": "cashier_presence",
    "restaurant_counter": "restaurant_counter", "restaurant": "restaurant_counter",
    "restaurant_table": "restaurant_table", "table_occupancy": "restaurant_table",
    "table_monitor": "restaurant_table",
    "vehicle_gate": "vehicle_gate",
    "horse_riding": "horse_riding", "horse_tracking": "horse_riding", "horse": "horse_riding",
}


def normalize_use_case(pipeline: str) -> str:
    try:
        return ALIASES[pipeline]
    except (KeyError, TypeError):
        raise ValueError(f"unknown pipeline type '{pipeline}'") from None


def _apply_inline_roi(rules: dict, roi: Any) -> None:
    """BasePipeline._apply_inline_roi, branch for branch."""
    if isinstance(roi, dict):
        if "clerk_zone" in roi:
            rules["clerk_zone"] = roi["clerk_zone"]
        if "visitor_zone" in roi:
            rules["visitor_zone"] = roi["visitor_zone"]
        if "tripwire" in roi:
            rules["tripwire"] = roi["tripwire"]
        elif "start" in roi and "end" in roi:
            rules["tripwire"] = roi
        elif "zone_polygon" in roi:
            rules["zone_polygon"] = roi["zone_polygon"]
        elif "dining_zone" in roi:
            rules["dining_zone"] = roi["dining_zone"]
        elif "roi_polygon" in roi:
            rules["roi_polygon"] = roi["roi_polygon"]
        elif "clerk_zone" not in roi and "visitor_zone" not in roi:
            rules["zone_polygon"] = roi
    elif isinstance(roi, list):
        rules["zone_polygon"] = roi
        rules["dining_zone"] = roi
        rules["roi_polygon"] = roi


def effective_rules(cam: dict, engine_dir: Path) -> dict:
    """Rule file (relative to engine_dir, as the engine runs from there), inline `rules`, inline `roi`."""
    rules: dict = {}
    rule_config = cam.get("rule_config", "")
    if rule_config:
        try:
            loaded = yaml.safe_load((Path(engine_dir) / rule_config).read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError):
            loaded = {}  # the engine logs the error and carries on with no rules
        rules = copy.deepcopy(loaded)
    inline = cam.get("rules")
    if inline and isinstance(inline, dict):
        rules.update(copy.deepcopy(inline))
    roi = cam.get("roi")
    if roi is not None:
        _apply_inline_roi(rules, copy.deepcopy(roi))
    return rules


def _resolve(node: Any, root: dict) -> Any:
    """Follow internal `#/...` $refs; sibling keywords of the $ref (default, ...) are merged on top."""
    hops = 0
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        if not ref.startswith("#/") or hops > 32:
            return node
        target: Any = root
        for part in ref[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        node = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
        hops += 1
    return node


def _pointer(parent: str, key: Any) -> str:
    return f"{parent}/{str(key).replace('~', '~0').replace('/', '~1')}"


def _prune(value: Any, node: Any, root: dict, path: str, dropped: list[str]) -> Any:
    node = _resolve(node, root)
    if not isinstance(node, dict):
        return value
    if isinstance(value, dict) and isinstance(node.get("properties"), dict):
        out = {}
        for key, item in value.items():
            if key in node["properties"]:
                out[key] = _prune(item, node["properties"][key], root, _pointer(path, key), dropped)
            else:
                dropped.append(_pointer(path, key))
        return out
    if isinstance(value, list) and isinstance(node.get("items"), dict):
        return [_prune(item, node["items"], root, _pointer(path, i), dropped) for i, item in enumerate(value)]
    return value


def to_settings(use_case: str, rules: dict, schema: dict) -> tuple[dict, list[str]]:
    rules = copy.deepcopy(rules)
    if use_case == "cashier_presence":
        zone = rules.get("clerk_zone")
        if zone is None:
            zone = rules.get("zone_polygon")
        rules["clerk_zone"] = DEFAULT_CLERK_ZONE if zone is None else zone
    elif use_case in ("horse_riding", "vehicle_gate"):
        if rules.get("roi_polygon") == []:
            del rules["roi_polygon"]
    elif use_case == "restaurant_table" and "table_monitoring" in rules:
        # the pipeline reads rules.get("table_monitoring", rules); top-level keys such as imgsz are
        # read by the base class, so they stay
        table_cfg = rules.pop("table_monitoring") or {}
        rules = {**rules, **table_cfg}
    dropped: list[str] = []
    settings = _prune(rules, schema, schema, "", dropped)
    return settings, sorted(dropped)


def source_type(source: str) -> str:
    parsed = urlparse(source)
    if parsed.scheme in ("rtsp", "rtsps"):
        try:
            port = parsed.port
        except ValueError:
            port = None
        return "MEDIAMTX" if port == 8554 else "RTSP"
    return "FILE"


def mask_url(url: str) -> str:
    return re.sub(r"^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@", r"\1***@", url)


def camera_payload(cam: dict, use_case: str, settings: dict) -> dict:
    source = cam["source"]
    nx_id = cam.get("nx_camera_id")
    return {
        "id": cam["id"],
        "name": cam.get("name", cam["id"]),
        "useCase": use_case,
        "enabled": cam.get("enabled", True),
        "sourceType": source_type(source),
        "mainStreamUrl": source,
        "targetFps": cam.get("target_fps") or 10,
        "recordingPath": cam.get("recording_path"),
        "nxCameraId": None if not nx_id or nx_id == NO_NX_ID else nx_id,
        "settings": settings,
        "note": "imported from cameras.yaml",
    }


def _label(payload: dict) -> str:
    url = payload.get("mainStreamUrl")
    return f"{payload.get('id')} ({mask_url(url)})" if url else str(payload.get("id"))


def import_cameras(payloads: list[dict], post: Callable[[dict], tuple[int, str]]) -> int:
    failed = 0
    for payload in payloads:
        status, body = post(payload)
        if status == 201:
            print(f"created: {_label(payload)}")
        elif status == 409:
            print(f"exists, skipped: {_label(payload)}")
        else:
            failed += 1
            print(f"FAILED: {_label(payload)}: HTTP {status} {body}")
    return 1 if failed else 0


def _make_post(api: str, token: str) -> Callable[[dict], tuple[int, str]]:
    import requests

    def post(payload: dict) -> tuple[int, str]:
        try:
            resp = requests.post(
                api.rstrip("/") + "/api/v1/cameras", json=payload,
                headers={"Authorization": f"Bearer {token}"}, timeout=HTTP_TIMEOUT_S,
            )
        except requests.RequestException as exc:
            return 0, f"request error: {type(exc).__name__}"
        return resp.status_code, resp.text
    return post


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Import cameras.yaml and rule files through the API")
    ap.add_argument("--cameras", required=True, type=Path, help="engine cameras.yaml")
    ap.add_argument("--engine-dir", type=Path, default=REPO / "services/engine",
                    help="folder the rule_config paths are relative to")
    ap.add_argument("--contracts-dir", type=Path, default=REPO / "packages/contracts/generated/schemas")
    ap.add_argument("--api", default="http://127.0.0.1:3001")
    ap.add_argument("--dry-run", action="store_true", help="print the payloads, send nothing")
    args = ap.parse_args(argv)

    token = os.environ.get("ZOO_API_TOKEN", "")
    if not args.dry_run and not token:
        print("ZOO_API_TOKEN is not set (a SUPERADMIN API token); use --dry-run to preview", file=sys.stderr)
        return 2

    cams = (yaml.safe_load(args.cameras.read_text(encoding="utf-8")) or {}).get("cameras") or []
    payloads: list[dict] = []
    errors = 0
    for cam in cams:
        try:
            uc = normalize_use_case(cam.get("pipeline"))
            schema = json.loads((args.contracts_dir / "usecases" / uc / "settings.json").read_text(encoding="utf-8"))
            settings, dropped = to_settings(uc, effective_rules(cam, args.engine_dir), schema)
            payloads.append(camera_payload(cam, uc, settings))
        except (ValueError, KeyError, OSError) as exc:
            errors += 1
            print(f"FAILED: {cam.get('id')}: {exc}")
            continue
        if dropped:
            print(f"{cam['id']}: dropped keys not in the {uc} schema: {', '.join(dropped)}")

    if args.dry_run:
        for p in payloads:
            print(json.dumps({**p, "mainStreamUrl": mask_url(p["mainStreamUrl"])}, indent=2))
        return 1 if errors else 0
    return 1 if (import_cameras(payloads, _make_post(args.api, token)) or errors) else 0


if __name__ == "__main__":
    sys.exit(main())
