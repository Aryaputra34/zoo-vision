"""A camera's config as the engine runs it: one entry of the API's `GET /internal/engine/cameras` snapshot.

`source_url` holds credentials: log it only through `core.stream_manager.mask_url`, and never put it in an error.
"""

from dataclasses import dataclass
from typing import Any


class ApiError(Exception):
    """The API could not give an answer (network, 4xx/5xx, bad body)."""


@dataclass(frozen=True)
class CameraConfig:
    id: str
    name: str
    use_case: str
    version: int
    settings: dict  # API-filled (every default present); parsed strictly by the worker
    source_url: str
    target_fps: int
    model_path: str  # relative to the models directory
    imgsz: int | tuple[int, int]  # a JSON list becomes a tuple, so configs compare by value and pool keys hash
    nx_camera_id: str | None

    @classmethod
    def from_api(cls, entry: Any) -> "CameraConfig":
        """An EngineCamera (Task 3). ValueError, naming the field but never its value, when malformed."""
        if not isinstance(entry, dict):
            raise ValueError("a camera entry must be an object")
        model = entry.get("model")
        if not isinstance(model, dict):
            raise ValueError("'model' must be an object")
        nx_camera_id = entry.get("nxCameraId")
        if nx_camera_id is not None and not isinstance(nx_camera_id, str):
            raise ValueError("'nxCameraId' must be a string or null")
        settings = entry.get("settings")
        if not isinstance(settings, dict):
            raise ValueError("'settings' must be an object")
        return cls(
            id=_text(entry, "id"),
            name=_text(entry, "name", allow_empty=True),
            use_case=_text(entry, "useCase"),
            version=_positive_int(entry.get("version"), "version"),
            settings=settings,
            source_url=_text(entry, "sourceUrl"),
            target_fps=_positive_int(entry.get("targetFps"), "targetFps"),
            model_path=_text(model, "path", where="model.path"),
            imgsz=_imgsz(model.get("imgsz")),
            nx_camera_id=nx_camera_id,
        )


def _text(obj: dict, key: str, *, allow_empty: bool = False, where: str | None = None) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not (value or allow_empty):
        raise ValueError(f"'{where or key}' must be a {'' if allow_empty else 'non-empty '}string")
    return value


def _positive_int(value: Any, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"'{where}' must be an integer of at least 1")
    return value


def _imgsz(value: Any) -> int | tuple[int, int]:
    if isinstance(value, (list, tuple)):
        if len(value) != 2:
            raise ValueError("'model.imgsz' must be an integer or a list of two integers")
        return (_positive_int(value[0], "model.imgsz"), _positive_int(value[1], "model.imgsz"))
    return _positive_int(value, "model.imgsz")
