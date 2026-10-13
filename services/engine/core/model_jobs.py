"""Model validation and ONNX conversion jobs. The API queues them on the Redis list `model:jobs`; the engine takes
each once (BRPOP), does the work, and reports the result over HTTP.

    {"type": "validate", "modelId": id, "path": <file under the models dir>}
    {"type": "convert", "modelId": source id, "targetId": new id, "path": <source file>,
     "outPath": "registry/<newId>.onnx", "imgsz": int | [h, w]}

Job paths are relative to the models dir; one that leaves it is reported as failed without touching the file.
"""

import hashlib
import json
import logging
import os
import shutil
import statistics
import tempfile
import threading
import time

import numpy as np
import redis

from core.camera_config import ApiError

logger = logging.getLogger("ModelJobs")

ERROR_MAX = 500
BRPOP_TIMEOUT_S = 5
BACKOFF_START_S, BACKOFF_MAX_S = 0.5, 5.0
DEFAULT_IMGSZ = 640


def _default_loader(path: str):
    from ultralytics import YOLO

    return YOLO(path, task="detect")


def _error(e: BaseException) -> dict:
    return {"ok": False, "error": f"{type(e).__name__}: {e}"[:ERROR_MAX]}


def _frame_shape(model) -> tuple[int, int]:
    """(height, width) of the validation frame: the model's imgsz when it has one, else 640."""
    imgsz = (getattr(model, "overrides", None) or {}).get("imgsz", DEFAULT_IMGSZ)
    if isinstance(imgsz, (list, tuple)) and len(imgsz) == 2:
        return int(imgsz[0]), int(imgsz[1])
    size = int(imgsz[0] if isinstance(imgsz, (list, tuple)) else imgsz)
    return size, size


def validate_model(path: str, device: str, *, loader=None) -> dict:
    """Loads the model and times 3 inferences on a black frame after one warm-up."""
    try:
        model = (loader or _default_loader)(path)
        names = model.names
        class_names = [str(names[i]) for i in sorted(names)] if isinstance(names, dict) else [str(n) for n in names]
        height, width = _frame_shape(model)
        frame = np.zeros((height, width, 3), np.uint8)
        model(frame, device=device, verbose=False)  # warm-up
        timings = []
        for _ in range(3):
            started = time.perf_counter()
            model(frame, device=device, verbose=False)
            timings.append((time.perf_counter() - started) * 1000)
        return {"ok": True, "classNames": class_names, "latencyMs": statistics.median(timings), "device": device}
    except Exception as e:
        return _error(e)


def convert_to_onnx(src: str, out: str, imgsz, *, loader=None, work_dir: str | None = None) -> dict:
    """Exports `src` to ONNX (dynamic shapes, opset 19, simplified) and moves the file to `out` in one step, so a
    partial file never sits at `out`. Returns the SHA-256 of the file at `out`.

    Ultralytics writes the export next to the model it loaded, replacing a file of that name. So it exports a copy
    of `src` inside a private directory under `work_dir` (the same disk as `out` when given), which is removed
    afterwards: nothing beside `src` is created or overwritten."""
    work = None
    try:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        work = tempfile.mkdtemp(prefix=".convert-", dir=work_dir or os.path.dirname(os.path.abspath(out)))
        copy = os.path.join(work, os.path.basename(src))
        shutil.copyfile(src, copy)
        model = (loader or _default_loader)(copy)
        exported = model.export(format="onnx", imgsz=imgsz, dynamic=True, half=False, opset=19, simplify=True)
        os.replace(exported, out)
        digest = hashlib.sha256()
        with open(out, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        return {"ok": True, "sha256": digest.hexdigest()}
    except Exception as e:
        return _error(e)
    finally:
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)


class OutsideModelsDir(ValueError):
    pass


class ModelJobs(threading.Thread):
    def __init__(self, redis_client, api, models_dir: str, device: str, *, loader=None, queue: str = "model:jobs"):
        super().__init__(name="model-jobs", daemon=True)
        self._client, self._api, self._device, self._loader, self._queue = redis_client, api, device, loader, queue
        self._root = os.path.realpath(models_dir)
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        backoff, down = BACKOFF_START_S, False
        while not self._stop_event.is_set():
            try:
                item = self._client.brpop(self._queue, timeout=BRPOP_TIMEOUT_S)
            except redis.RedisError as e:
                if not down:
                    logger.warning("Lost the %s queue (%s); retrying", self._queue, type(e).__name__)
                    down = True
                self._stop_event.wait(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
                continue
            if down:
                logger.info("The %s queue is back", self._queue)
            backoff, down = BACKOFF_START_S, False
            if item is None:
                continue
            try:
                job = json.loads(item[1])
            except ValueError:
                logger.warning("Dropping a job that is not JSON")
                continue
            try:
                self.handle(job)
            except Exception:
                logger.exception("A model job failed unexpectedly")

    def handle(self, job: dict) -> None:
        kind = job.get("type") if isinstance(job, dict) else None
        try:
            if kind == "validate" and _is_str(job, "modelId", "path"):
                self._api.report_validation(job["modelId"], self._validate(job["path"]))
            elif kind == "convert" and _is_str(job, "modelId", "targetId", "path", "outPath") and "imgsz" in job:
                self._api.report_conversion(job["targetId"], self._convert(job))
            else:
                logger.warning("Dropping a job of unknown type or with missing fields (type %r)", kind)
        except ApiError as e:
            logger.warning("Could not report a %s job: %s", kind, e)

    def _validate(self, path: str) -> dict:
        try:
            full = self._inside(path)
        except OutsideModelsDir as e:
            return {"ok": False, "error": str(e)}
        return validate_model(full, self._device, loader=self._loader)

    def _convert(self, job: dict) -> dict:
        try:
            src, out = self._inside(job["path"]), self._inside(job["outPath"])
        except OutsideModelsDir as e:
            return {"ok": False, "error": str(e)}
        result = convert_to_onnx(src, out, job["imgsz"], loader=self._loader, work_dir=self._root)
        if result["ok"]:
            result["path"] = job["outPath"]
        return result

    def _inside(self, relative: str) -> str:
        full = os.path.realpath(os.path.join(self._root, relative))
        try:
            inside = os.path.commonpath([self._root, full]) == self._root
        except ValueError:  # another drive
            inside = False
        if not inside:
            raise OutsideModelsDir("the path is outside the models directory")
        return full


def _is_str(job: dict, *keys: str) -> bool:
    return all(isinstance(job.get(k), str) and job[k] for k in keys)
