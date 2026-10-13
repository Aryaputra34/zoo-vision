import json
import logging
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from core.api_client import EngineApi
from core.camera_config import ApiError

TOKEN = "secret-token-" + "x" * 24


def entry(camera_id="cam1", **over):
    e = {"id": camera_id, "name": "Cam", "useCase": "vehicle_gate", "version": 1, "settings": {},
         "sourceUrl": "rtsp://admin:s3cret@10.0.0.5/main", "targetFps": 5,
         "model": {"path": "a.onnx", "imgsz": [640, 480]}, "nxCameraId": None}
    e.update(over)
    return e


class FakeApi:
    """A canned answer (status, body) for every request; records (method, path, headers, body)."""

    def __init__(self):
        self.status, self.body = 200, b"{}"
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                outer.requests.append((self.command, self.path, dict(self.headers), self.rfile.read(length)))
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(outer.body)))
                self.end_headers()
                self.wfile.write(outer.body)

            do_GET = do_POST = _answer

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def serve(self, cameras):
        self.body = json.dumps({"cameras": cameras}).encode()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


@pytest.fixture
def api_server():
    s = FakeApi()
    yield s
    s.close()


def test_cameras_sends_the_token_and_group_and_parses_entries(api_server):
    api_server.serve([entry("cam1"), entry("cam2", nxCameraId="nx-2")])
    cameras = EngineApi(api_server.url, TOKEN, "park-a").cameras()
    assert [c.id for c in cameras] == ["cam1", "cam2"]
    assert cameras[0].imgsz == (640, 480) and cameras[1].nx_camera_id == "nx-2"
    [(method, path, headers, _)] = api_server.requests
    assert method == "GET" and path == "/internal/engine/cameras?group=park-a"
    assert headers["Authorization"] == f"Bearer {TOKEN}"


def test_a_malformed_entry_is_skipped(api_server, caplog):
    api_server.serve([entry("cam1"), entry("bad", targetFps=0), "nonsense", entry("cam3")])
    with caplog.at_level(logging.WARNING):
        cameras = EngineApi(api_server.url, TOKEN, "g").cameras()
    assert [c.id for c in cameras] == ["cam1", "cam3"]
    assert "bad" in caplog.text
    assert "s3cret" not in caplog.text and "10.0.0.5" not in caplog.text


@pytest.mark.parametrize("answer", [500, 401, "not json", "no cameras list", "refused"])
def test_failures_raise_api_error_without_the_token(api_server, answer):
    base = api_server.url
    if answer == "refused":
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            base = f"http://user:pw@127.0.0.1:{s.getsockname()[1]}"
    elif answer == "not json":
        api_server.body = b"<html>"
    elif answer == "no cameras list":
        api_server.body = b'{"cameras": 3}'
    else:
        api_server.status = answer
    with pytest.raises(ApiError) as e:
        EngineApi(base, TOKEN, "g", timeout=2).cameras()
    assert TOKEN not in str(e.value) and "pw" not in str(e.value) and "secret-token" not in str(e.value)


def test_reports_post_json(api_server):
    api = EngineApi(api_server.url, TOKEN, "g")
    api.report_validation("m1", {"ok": True})
    api.report_conversion("m2", {"status": "READY"})
    (m1, p1, h1, b1), (m2, p2, _, b2) = api_server.requests
    assert (m1, p1, m2, p2) == ("POST", "/internal/engine/models/m1/validation", "POST",
                                "/internal/engine/models/m2/conversion")
    assert json.loads(b1) == {"ok": True} and json.loads(b2) == {"status": "READY"}
    assert h1["Authorization"] == f"Bearer {TOKEN}" and h1["Content-Type"].startswith("application/json")
    api_server.status = 500
    with pytest.raises(ApiError):
        api.report_validation("m1", {})
