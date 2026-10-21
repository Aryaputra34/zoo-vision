import pytest

from core.env import EngineEnv, EnvError, load_env

BASE = {"REDIS_URL": "redis://localhost:6379/0", "ENGINE_TOKEN": "x" * 32}


def test_defaults():
    env = load_env(BASE)
    assert isinstance(env, EngineEnv)
    assert (env.engine_group, env.api_url, env.max_batch, env.model_jobs) == (
        "default", "http://127.0.0.1:3001", 1, True)
    assert (env.device, env.models_dir, env.snapshot_dir, env.snapshot_retention_days) == (
        "cpu", "models", "snapshots", 0)


def test_overrides():
    env = load_env({**BASE, "REDIS_URL": "rediss://h:1", "ENGINE_GROUP": "north_1", "ENGINE_MAX_BATCH": "16",
                    "ENGINE_MODEL_JOBS": "off", "SNAPSHOT_RETENTION_DAYS": "0"})
    assert (env.engine_group, env.max_batch, env.model_jobs,
            env.snapshot_retention_days) == ("north_1", 16, False, 0)


def test_every_bad_variable_is_named_without_its_value():
    with pytest.raises(EnvError) as e:
        load_env({"REDIS_URL": "http://x", "ENGINE_TOKEN": "short-secret", "ENGINE_GROUP": "Bad Group",
                  "ENGINE_MAX_BATCH": "0"})
    msg = str(e.value)
    for name in ("REDIS_URL", "ENGINE_TOKEN", "ENGINE_GROUP", "ENGINE_MAX_BATCH"):
        assert name in msg
    assert "short-secret" not in msg and "Bad Group" not in msg


def test_missing_required_variables_are_named():
    with pytest.raises(EnvError) as e:
        load_env({})
    assert "REDIS_URL" in str(e.value) and "ENGINE_TOKEN" in str(e.value)


@pytest.mark.parametrize("name, value", [
    ("ENGINE_MAX_BATCH", "17"), ("ENGINE_MAX_BATCH", "abc"),
    ("SNAPSHOT_RETENTION_DAYS", "-1"), ("ENGINE_MODEL_JOBS", "maybe"),
    ("ENGINE_GROUP", ""),
])
def test_out_of_range_values_rejected(name, value):
    with pytest.raises(EnvError) as e:
        load_env({**BASE, name: value})
    assert name in str(e.value)


def test_repr_hides_the_secrets():
    env = load_env({**BASE, "REDIS_URL": "redis://:hunter2@redis:6379/0", "ENGINE_TOKEN": "tok-" + "s" * 40})
    text = repr(env)
    assert "hunter2" not in text and "tok-sss" not in text
    assert "engine_group='default'" in text  # the rest is still there
    assert env.redis_url == "redis://:hunter2@redis:6379/0"
