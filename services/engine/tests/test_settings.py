import json

import pytest
from contracts.registry import REGISTRY
from core.settings import SettingsError, parse_settings
from tests.conftest import ENGINE_DIR

CONTRACTS = ENGINE_DIR.parent.parent / "packages" / "contracts" / "usecases"


def load_example(use_case):
    return json.loads((CONTRACTS / use_case / "examples" / "settings" / "valid" / "current_rules.json")
                      .read_text(encoding="utf-8"))


def test_filled_example_passes_strictly():
    s = parse_settings("vehicle_gate", load_example("vehicle_gate"))  # the example sets tripwire
    assert s.tripwire.start == (0.76, 0.58)


def test_null_anywhere_is_rejected_with_its_path():
    with pytest.raises(SettingsError) as e:
        parse_settings("horse_riding", {"tripwire": {"enabled": None}})
    assert e.value.path == "/tripwire/enabled"
    assert "null is not allowed" in str(e.value)


def test_strict_refuses_a_number_in_a_string():
    with pytest.raises(SettingsError) as e:
        parse_settings("horse_riding", {"lost_track_buffer": "60"})
    assert e.value.path == "/lost_track_buffer"


def test_lax_fills_pydantic_defaults():
    assert parse_settings("restaurant_counter", {}, strict=False).tripwire.start == (0.1, 0.5)


@pytest.mark.parametrize("use_case", ["system", "nope"])
def test_use_case_without_settings(use_case):
    with pytest.raises(SettingsError) as e:
        parse_settings(use_case, {})
    assert e.value.path == ""


def test_defaulted_fields_are_not_optional():
    assert REGISTRY["horse_riding"].settings.model_fields["lost_track_buffer"].annotation is int


def test_unique_ids_are_checked_at_every_match_of_a_wildcard_pointer():
    from core.settings import _check_unique_ids

    room = {"id": "R1"}
    doc = {"floors": [{"rooms": [room]}, {"rooms": [room, room]}], "other": {"rooms": [room, room]}}
    with pytest.raises(SettingsError) as e:
        _check_unique_ids(("/floors/*/rooms",), doc)
    assert e.value.path == "/floors/1/rooms/1/id"
    _check_unique_ids(("/floors/*/rooms", "/missing/*/x"), {"floors": [{"rooms": [room]}]})
