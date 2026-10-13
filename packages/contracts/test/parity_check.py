"""Runs the engine's own validators over the cases on stdin; the JS side compares the verdicts.

Usage: python -I parity_check.py <services/engine dir>
stdin:  [{"kind": "settings", "useCase", "doc", "strict"} | {"kind": "message", "doc"}]
stdout: [{"ok": bool, "dump": ...}]   dump = model_dump(mode="json", exclude_none=True) for accepted settings
"""

import json
import sys

sys.path.insert(0, sys.argv[1])

from core.messages import ContractError, validate  # noqa: E402
from core.settings import SettingsError, parse_settings  # noqa: E402


def run(case):
    try:
        if case["kind"] == "settings":
            model = parse_settings(case["useCase"], case["doc"], strict=case["strict"])
            return {"ok": True, "dump": model.model_dump(mode="json", exclude_none=True)}
        validate(case["doc"])
        return {"ok": True}
    except (SettingsError, ContractError):
        return {"ok": False}


json.dump([run(c) for c in json.load(sys.stdin)], sys.stdout)
