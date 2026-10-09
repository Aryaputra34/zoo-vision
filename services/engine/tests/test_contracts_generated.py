from contracts.envelope import Message
from contracts.registry import REGISTRY


def test_system_use_case_is_generated():
    started = REGISTRY["system"].events["engine_started"]
    assert started(bootId="0" * 32, engineGroup="default").engineGroup == "default"
    assert REGISTRY["system"].settings is None and REGISTRY["system"].schema_version == 1


def test_envelope_selects_the_branch_by_message_field():
    msg = Message.model_validate_json(
        '{"message": "event", "cameraId": null, "useCase": "system", "schemaVersion": 1, "configVersion": null,'
        ' "time": "2026-10-09T10:00:00.000Z", "id": "evt_' + "0" * 32 + '", "type": "engine_started",'
        ' "severity": "info", "snapshotPath": null, "data": {}}'
    )
    assert msg.root.type == "engine_started"
