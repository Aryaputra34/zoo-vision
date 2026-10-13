"""The engine's client of the API's internal routes. Every request carries `Authorization: Bearer <token>`.

Errors never carry the token or the base URL (it may hold credentials): ApiError names the status or the kind of
failure only. A camera entry that does not parse is skipped and logged by id, never by URL; its id is in the
answer's `skipped_ids`, so the supervisor leaves that camera running what it runs.
"""

import logging
from urllib.parse import quote

import requests

from core.camera_config import ApiError, CameraConfig, CameraList

logger = logging.getLogger("EngineApi")


class EngineApi:
    def __init__(self, base_url: str, token: str, group: str, *, timeout: float = 5.0, session=None):
        self._base = base_url.rstrip("/")
        self._group, self._timeout = group, timeout
        self._session = session or requests.Session()
        self._headers = {"Authorization": f"Bearer {token}"}

    def cameras(self) -> CameraList:
        body = self._request("GET", "/internal/engine/cameras", json_answer=True, params={"group": self._group})
        entries = body.get("cameras") if isinstance(body, dict) else None
        if not isinstance(entries, list):
            raise ApiError("the API answer has no 'cameras' list")
        cameras, skipped = [], []
        for entry in entries:
            try:
                cameras.append(CameraConfig.from_api(entry))
            except ValueError as e:
                camera_id = entry.get("id") if isinstance(entry, dict) else None
                if isinstance(camera_id, str) and camera_id:
                    skipped.append(camera_id)
                logger.warning("Skipping a malformed camera entry (id %s): %s", camera_id if isinstance(camera_id, str)
                               else "unknown", e)
        return CameraList(cameras, skipped)

    def report_validation(self, model_id: str, body: dict) -> None:
        self._request("POST", f"/internal/engine/models/{quote(model_id, safe='')}/validation", json=body)

    def report_conversion(self, model_id: str, body: dict) -> None:
        self._request("POST", f"/internal/engine/models/{quote(model_id, safe='')}/conversion", json=body)

    def _request(self, method: str, path: str, *, json_answer: bool = False, **kwargs):
        """Any 2xx is a success. With json_answer, returns the parsed answer (no body or not JSON: ApiError); else
        the answer is not read (a report is answered 204, with no body)."""
        try:
            response = self._session.request(method, self._base + path, headers=self._headers,
                                             timeout=self._timeout, **kwargs)
        except requests.RequestException as e:
            raise ApiError(f"{method} {path}: {type(e).__name__}") from None
        if not response.ok:
            raise ApiError(f"{method} {path}: HTTP {response.status_code}")
        if not json_answer:
            return None
        try:
            return response.json()
        except ValueError:
            raise ApiError(f"{method} {path}: the answer is not JSON") from None
