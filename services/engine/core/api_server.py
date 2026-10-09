"""
AI Engine HTTP API for the web dashboard (zoo-vision-fe proxies it behind its login).
  GET /health                  per-camera FPS and online state
  GET /frame/{camera_id}       latest annotated frame, one JPEG
  GET /stream/{camera_id}      annotated live preview as MJPEG; frames are encoded only while someone watches
  GET /snapshots/{path}        event snapshots saved by SnapshotStore
Runs uvicorn in a daemon thread next to the inference workers. With api_key set, every request needs
"Authorization: Bearer <api_key>".
"""

import hmac
import time
import asyncio
import logging
import threading
from typing import Dict, Optional

import cv2
import numpy as np
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from core.base_pipeline import BasePipeline
from core.snapshot_store import SnapshotStore

logger = logging.getLogger("ApiServer")

PREVIEW_MAX_FPS = 25
PREVIEW_MAX_WIDTH = 960
ONLINE_SEC = 10


def _encode(frame: np.ndarray, quality: int = 70) -> Optional[bytes]:
    h, w = frame.shape[:2]
    if w > PREVIEW_MAX_WIDTH:
        frame = cv2.resize(frame, (PREVIEW_MAX_WIDTH, int(h * PREVIEW_MAX_WIDTH / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else None


def create_app(
    pipelines: Dict[str, BasePipeline],
    snapshots: Optional[SnapshotStore] = None,
    api_key: Optional[str] = None,
) -> FastAPI:
    want = f"Bearer {api_key}".encode() if api_key else None

    def check_key(request: Request):
        if want and not hmac.compare_digest(request.headers.get("authorization", "").encode(), want):
            raise HTTPException(401, "unauthorized")

    app = FastAPI(title="Zoo Vision AI Engine", docs_url=None, redoc_url=None, openapi_url=None,
                  dependencies=[Depends(check_key)])
    no_store = {"Cache-Control": "no-store, no-transform"}

    def pipeline_or_404(camera_id: str) -> BasePipeline:
        p = pipelines.get(camera_id)
        if p is None:
            raise HTTPException(404, "unknown camera")
        return p

    @app.get("/health")
    def health():
        now = time.time()
        return {
            "cameras": [
                {
                    "id": cid,
                    "name": p.camera_name,
                    "useCase": p.use_case,
                    "fps": round(p.fps, 1),
                    "online": now - p.last_frame_at < ONLINE_SEC,
                }
                for cid, p in pipelines.items()
            ]
        }

    @app.get("/frame/{camera_id}")
    async def frame(camera_id: str):
        f = pipeline_or_404(camera_id).latest_frame()
        jpg = await asyncio.to_thread(_encode, f) if f is not None else None
        if jpg is None:
            raise HTTPException(503, "no frame yet")
        return Response(jpg, media_type="image/jpeg", headers=no_store)

    @app.get("/stream/{camera_id}")
    async def stream(camera_id: str, request: Request):
        p = pipeline_or_404(camera_id)

        async def parts():
            last = None
            while not await request.is_disconnected():
                f = p.latest_frame()
                if f is not None and f is not last:  # pipelines publish a new array per frame
                    last = f
                    jpg = await asyncio.to_thread(_encode, f)
                    if jpg:
                        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
                await asyncio.sleep(1 / PREVIEW_MAX_FPS)

        return StreamingResponse(parts(), media_type="multipart/x-mixed-replace; boundary=frame", headers=no_store)

    @app.get("/snapshots/{path:path}")
    def snapshot(path: str):
        f = snapshots.resolve(path) if snapshots else None
        if f is None:
            raise HTTPException(404, "no such snapshot")
        return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})

    return app


def start_api_server(app: FastAPI, host: str = "127.0.0.1", port: int = 8000) -> uvicorn.Server:
    """Starts uvicorn in a daemon thread. Stop it with server.should_exit = True."""
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True, name="ApiServer").start()
    logger.info(f"AI engine API listening on http://{host}:{port} (preview, snapshots, health)")
    return server
