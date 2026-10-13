"""Validation of a camera's per-use-case settings against the generated Pydantic models.

The API is the runtime source of settings defaults (ajv fills them in), so the engine validates strictly and
rejects what ajv rejects. `null` is never a valid settings value: Pydantic accepts it for optional fields
without a default, ajv does not, so it is refused here before Pydantic sees it. A parity test in
packages/contracts (test/parity.test.mjs) pins these verdicts and the defaults to the JS validator.
"""

import json
from typing import Any

from contracts.registry import REGISTRY
from pydantic import BaseModel, ValidationError


class SettingsError(ValueError):
    """Settings that do not satisfy the contract. `path` is the JSON pointer of the first problem."""

    def __init__(self, path: str, message: str):
        super().__init__(f"{path or '(document)'}: {message}")
        self.path = path
        self.message = message


def _pointer(parts) -> str:
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _find_null(value: Any, parts: tuple = ()) -> tuple | None:
    if value is None:
        return parts
    children = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, (list, tuple)) else ()
    for key, child in children:
        found = _find_null(child, (*parts, key))
        if found is not None:
            return found
    return None


def parse_settings(use_case: str, settings: dict, *, strict: bool = True) -> BaseModel:
    """Validate `settings` for `use_case` and return the model.

    strict=True expects API-filled settings (every default present) and refuses type coercion. Pydantic cannot
    strictly validate a list default for a tuple field, so a missing `tripwire` fails here.
    strict=False fills Pydantic's own defaults; it is for local YAML rule files and tests.
    """
    contract = REGISTRY.get(use_case)
    if contract is None or contract.settings is None:
        raise SettingsError("", f"use case '{use_case}' has no settings")

    null_at = _find_null(settings)
    if null_at is not None:
        raise SettingsError(_pointer(null_at), "null is not allowed")

    try:
        if strict:
            model = contract.settings.model_validate_json(json.dumps(settings, allow_nan=False), strict=True)
        else:
            model = contract.settings.model_validate(settings)
    except ValidationError as e:
        first = e.errors()[0]
        raise SettingsError(_pointer(first["loc"]), first["msg"]) from e
    except (TypeError, ValueError) as e:  # json.dumps refused the document (NaN, non-JSON types)
        raise SettingsError("", str(e)) from e

    _check_unique_ids(contract.unique_id_lists, settings)
    return model


def _matches(doc: Any, parts: list[str], at: str = ""):
    """Yields (pointer, value) for every place in `doc` that the pointer `parts` reaches; `*` is any array index."""
    if not parts:
        yield at, doc
        return
    key, rest = parts[0], parts[1:]
    if key == "*":
        if isinstance(doc, list):
            for index, item in enumerate(doc):
                yield from _matches(item, rest, f"{at}/{index}")
    elif isinstance(doc, dict) and key in doc:
        yield from _matches(doc[key], rest, f"{at}/{key}")


def _check_unique_ids(pointers: tuple[str, ...], settings: dict) -> None:
    """Pydantic cannot say "items have unique ids"; validateSettings in the JS validator does."""
    for pointer in pointers:
        for list_at, items in _matches(settings, pointer.split("/")[1:]):
            if not isinstance(items, list):
                continue
            seen = set()
            for index, item in enumerate(items):
                item_id = item.get("id") if isinstance(item, dict) else None
                if item_id in seen:
                    raise SettingsError(f"{list_at}/{index}/id", f"duplicate id '{item_id}'")
                seen.add(item_id)
