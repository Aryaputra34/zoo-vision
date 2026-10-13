"""Engine environment configuration, validated once at startup."""

import os
import re
from dataclasses import dataclass, field
from typing import Mapping, Optional

GROUP_PATTERN = re.compile(r"^[a-z0-9_-]{1,32}$")


class EnvError(ValueError):
    """Names every invalid variable; never includes a value."""


@dataclass(frozen=True)
class EngineEnv:
    """The secrets (the Redis URL may hold a password) stay out of repr(), so logging the env never leaks them."""

    redis_url: str = field(repr=False)
    api_url: str
    engine_token: str = field(repr=False)
    engine_group: str
    device: str
    models_dir: str
    snapshot_dir: str
    snapshot_retention_days: int
    preview_host: str
    preview_port: int
    preview_api_key: str = field(repr=False)
    max_batch: int
    model_jobs: bool


def _int(source: Mapping[str, str], name: str, default: int, low: int, high: Optional[int], bad: list) -> int:
    raw = source.get(name)
    if raw is None:
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        bad.append(f"{name} must be an integer")
        return default
    if value < low or (high is not None and value > high):
        bad.append(f"{name} must be {low}..{high}" if high is not None else f"{name} must be >= {low}")
        return default
    return value


def load_env(source: Optional[Mapping[str, str]] = None) -> EngineEnv:
    env = os.environ if source is None else source
    bad: list[str] = []

    redis_url = env.get("REDIS_URL", "")
    if not redis_url:
        bad.append("REDIS_URL is required")
    elif not redis_url.startswith(("redis://", "rediss://")):
        bad.append("REDIS_URL must start with redis:// or rediss://")

    token = env.get("ENGINE_TOKEN", "")
    if not token:
        bad.append("ENGINE_TOKEN is required")
    elif len(token) < 32:
        bad.append("ENGINE_TOKEN must be at least 32 characters")

    group = env.get("ENGINE_GROUP", "default")
    if not GROUP_PATTERN.match(group):
        bad.append("ENGINE_GROUP must match ^[a-z0-9_-]{1,32}$")

    retention = _int(env, "SNAPSHOT_RETENTION_DAYS", 30, 0, None, bad)
    port = _int(env, "PREVIEW_PORT", 8000, 0, 65535, bad)
    max_batch = _int(env, "ENGINE_MAX_BATCH", 1, 1, 16, bad)

    jobs_raw = env.get("ENGINE_MODEL_JOBS", "on").strip().lower()
    if jobs_raw not in ("on", "off"):
        bad.append("ENGINE_MODEL_JOBS must be on or off")

    if bad:
        raise EnvError("invalid engine environment: " + "; ".join(bad))

    return EngineEnv(
        redis_url=redis_url,
        api_url=env.get("API_URL", "http://127.0.0.1:3001"),
        engine_token=token,
        engine_group=group,
        device=env.get("DEVICE", "cpu"),
        models_dir=env.get("ZOO_MODELS_DIR", "models"),
        snapshot_dir=env.get("SNAPSHOT_DIR", "snapshots"),
        snapshot_retention_days=retention,
        preview_host=env.get("PREVIEW_HOST", "127.0.0.1"),
        preview_port=port,
        preview_api_key=env.get("PREVIEW_API_KEY", ""),
        max_batch=max_batch,
        model_jobs=jobs_raw == "on",
    )
