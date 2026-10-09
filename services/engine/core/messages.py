"""Builders and validator for the messages on the Redis stream.

`validate` mirrors `validateMessage` in packages/contracts/src/index.js, in the same order.
"""

import json
import time
from datetime import datetime, timezone
from functools import cache
from typing import Annotated, Any
from uuid import uuid4

import numpy as np
from contracts.envelope import Message
from contracts.registry import REGISTRY
from pydantic import BaseModel, ConfigDict, ValidationError, create_model


class ContractError(ValueError):
    pass


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def iso_ms(epoch_ms: int) -> str:
    seconds, ms = divmod(int(epoch_ms), 1000)
    return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


def _plain(value: Any) -> Any:
    """numpy scalars/arrays and tuples to JSON-able Python values."""
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _now_ms() -> int:
    return int(time.time() * 1000)


def _envelope(kind: str, camera_id: str | None, use_case: str, time_ms: int | None) -> dict:
    contract = REGISTRY.get(use_case)
    return {
        "message": kind,
        "cameraId": camera_id,
        "useCase": use_case,
        "schemaVersion": contract.schema_version if contract else 1,
        "configVersion": None,
        "time": iso_ms(_now_ms() if time_ms is None else time_ms),
    }


def event_message(camera_id: str | None, use_case: str, type: str, data: dict, severity: str = "info",
                  time_ms: int | None = None, snapshot_path: str | None = None, event_id: str | None = None) -> dict:
    return {
        **_envelope("event", camera_id, use_case, time_ms),
        "id": event_id or new_id("evt"),
        "type": type,
        "severity": severity,
        "snapshotPath": snapshot_path,
        "data": _plain(data),
    }


def interval_open_message(camera_id: str, use_case: str, kind: str, subject_id: str | None,
                          data: dict | None = None, time_ms: int | None = None, session_id: str | None = None) -> dict:
    return {
        **_envelope("interval_open", camera_id, use_case, time_ms),
        "sessionId": session_id or new_id("ses"),
        "kind": kind,
        "subjectId": subject_id,
        "data": _plain(data or {}),
    }


def interval_close_message(camera_id: str, use_case: str, kind: str, session_id: str, data: dict | None = None,
                           time_ms: int | None = None, end_reason: str = "ended") -> dict:
    return {
        **_envelope("interval_close", camera_id, use_case, time_ms),
        "sessionId": session_id,
        "kind": kind,
        "endReason": end_reason,
        "data": _plain(data or {}),
    }


def metric_message(camera_id: str, use_case: str, name: str, minute_ms: int, value: float) -> dict:
    return {
        **_envelope("metric", camera_id, use_case, minute_ms),
        "name": name,
        "value": _plain(value),
    }


@cache
def _partial(model: type[BaseModel]) -> type[BaseModel]:
    """The model with every field optional, for `interval_close.data` (a partial merged into the open data).

    Absent fields are fine; present ones are still type-checked and unknown keys still rejected.
    """
    fields = {
        name: (Annotated[(info.annotation, *info.metadata)] if info.metadata else info.annotation, None)
        for name, info in model.model_fields.items()
    }
    return create_model(f"{model.__name__}Partial", __config__=ConfigDict(extra="forbid"), **fields)


def _check(model: type[BaseModel], payload: Any, where: str) -> None:
    try:
        model.model_validate_json(json.dumps(payload, allow_nan=False), strict=True)
    except (ValidationError, TypeError, ValueError) as e:
        raise ContractError(f"{where}: {e}") from e


def validate(message: dict) -> None:
    _check(Message, message, "envelope")

    use_case = message["useCase"]
    contract = REGISTRY.get(use_case)
    if contract is None:
        raise ContractError(f"unknown use case '{use_case}'")
    if message["schemaVersion"] != contract.schema_version:
        raise ContractError(f"use case '{use_case}' is at schemaVersion {contract.schema_version}")
    if message["cameraId"] is None and use_case != "system":
        raise ContractError("cameraId may be null only for the 'system' use case")

    kind = message["message"]
    if kind == "metric":
        if message["name"] not in contract.metrics:
            raise ContractError(f"unknown metric '{message['name']}' for use case '{use_case}'")
        return

    field, defs = ("type", contract.events) if kind == "event" else ("kind", contract.intervals)
    model = defs.get(message[field])
    if model is None:
        raise ContractError(f"unknown {field} '{message[field]}' for use case '{use_case}'")
    if kind == "interval_close":
        model = _partial(model)
    _check(model, message["data"], "data")
