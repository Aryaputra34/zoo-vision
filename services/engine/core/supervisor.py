"""
Keeps one CameraWorker per camera of the API's snapshot, and restarts the ones that stall.

Threads: run() is the supervisor's thread. It syncs (fetch, then reconcile) at once, on request and every resync_sec,
and checks for stalls every second. request_sync() may be called from any thread (the cfg:changed listener): it only
sets a deadline. reconcile(), check_stalls() and shutdown() hold `_lock`, so they never interleave. `workers` is
replaced, never changed in place, so readers in other threads (pipelines(), the status publisher) get a consistent
snapshot without the lock.
"""

import logging
import math
import threading
import time
from typing import Callable, Iterable

from core.base_pipeline import BasePipeline
from core.camera_config import ApiError, CameraConfig
from core.stream_manager import mask_url
from core.worker import CameraWorker, WorkerDeps

logger = logging.getLogger("Supervisor")

STALL_CHECK_S = 1.0
RETRY_MIN_S = 1.0  # after a failed sync, retry after 1 s, doubling up to resync_sec
STOP_POLL_S = 0.1  # how quickly run() notices its stop event
SHUTDOWN_S = 10.0


class Supervisor:
    def __init__(self, api, deps: WorkerDeps, *, worker_factory=CameraWorker, resync_sec: float = 60.0,
                 debounce_sec: float = 0.2, stall_sec: float = 30.0, clock: Callable[[], float] = time.time,
                 on_stop: Callable[[str], None] = lambda camera_id: None):
        self.api = api  # cameras() -> list[CameraConfig], raising ApiError
        self.deps = deps
        self.worker_factory = worker_factory
        self.resync_sec, self.debounce_sec, self.stall_sec = resync_sec, debounce_sec, stall_sec
        self.clock = clock
        self.on_stop = on_stop  # called with the camera id after a worker stopped (removed, replaced or shut down)
        self.workers: dict[str, CameraWorker] = {}
        self._lock = threading.Lock()
        self._requests = threading.Lock()
        self._sync_due: float | None = None  # monotonic time of a requested sync
        self._wake = threading.Event()
        self._api_down = False
        self._closed = False

    def pipelines(self) -> dict[str, BasePipeline]:
        return {camera_id: w.pipeline for camera_id, w in self.workers.items() if w.pipeline is not None}

    def reconcile(self, configs: list[CameraConfig]) -> None:
        """Starts the workers of new cameras, stops the ones no longer listed (config_change), updates the rest."""
        wanted: dict[str, CameraConfig] = {}
        for config in configs:
            if config.id in wanted:
                logger.warning("[%s] The camera is listed twice; using its last entry", config.id)
            wanted[config.id] = config
        with self._lock:
            if self._closed:
                return
            for camera_id in [c for c in self.workers if c not in wanted]:
                worker = self.workers[camera_id]
                self.workers = {c: w for c, w in self.workers.items() if c != camera_id}
                logger.info("[%s] Camera removed from the snapshot: stopping it", camera_id)
                self._stop(worker, "config_change")
            for camera_id, config in wanted.items():
                try:
                    worker = self.workers.get(camera_id)
                    if worker is None:
                        logger.info("[%s] Camera added: %s v%d, stream %s at %d fps", camera_id, config.use_case,
                                    config.version, mask_url(config.source_url), config.target_fps)
                        self._start(config)
                    else:
                        worker.update(config)
                except Exception:  # one camera's failure must not stop the others
                    logger.exception("[%s] Could not reconcile the camera", camera_id)

    def sync(self) -> bool:
        """Fetches the snapshot and reconciles. False when the API gave no answer: every camera keeps its config."""
        try:
            configs = self.api.cameras()
        except ApiError as e:
            if not self._api_down:
                self._api_down = True
                logger.warning("Cannot read the cameras from the API (%s); %d camera(s) keep their current config "
                               "until it answers", e, len(self.workers))
            return False
        if self._api_down:
            self._api_down = False
            logger.info("The API answers again")
        self.reconcile(configs)
        return True

    def request_sync(self) -> None:
        """Thread-safe. Runs a sync debounce_sec from now; requests made before it runs join it."""
        with self._requests:
            if self._sync_due is None:
                self._sync_due = time.monotonic() + self.debounce_sec
        self._wake.set()

    def check_stalls(self) -> None:
        """Stops (engine_stop) and restarts every stalled worker; the new worker's restarts is one more."""
        now = self.clock()
        with self._lock:
            if self._closed:
                return
            for camera_id, worker in list(self.workers.items()):
                if not worker.stalled(now, self.stall_sec):
                    continue
                logger.warning("[%s] The stream delivers but no frame was processed for %.0f s: restarting the camera",
                               camera_id, self.stall_sec)
                self._stop(worker, "engine_stop")
                self.workers = {c: w for c, w in self.workers.items() if c != camera_id}
                start_from = worker.restart_config()
                try:
                    successor = self._start(start_from, restarts=worker.restarts + 1,
                                            rejected=worker.rejected_versions)
                    if start_from != worker.config:
                        successor.update(worker.config)
                except Exception:  # the camera is out of `workers`, so the next sync starts it again
                    logger.exception("[%s] Could not restart the camera", camera_id)

    def run(self, stop: threading.Event) -> None:
        """Syncs at once, then on request or every resync_sec (sooner while the API gives no answer); checks for
        stalls every second. Returns once `stop` is set."""
        next_sync = time.monotonic()
        next_stall_check = next_sync + STALL_CHECK_S
        retry = RETRY_MIN_S
        while not stop.is_set():
            now = time.monotonic()
            with self._requests:
                due_now = now >= next_sync or (self._sync_due is not None and now >= self._sync_due)
                if due_now:
                    self._sync_due = None  # this fetch starts after every request made so far
            if due_now:
                if self._safe_sync():
                    retry = RETRY_MIN_S
                    next_sync = time.monotonic() + self.resync_sec
                else:
                    next_sync = time.monotonic() + min(retry, self.resync_sec)
                    retry = min(retry * 2, self.resync_sec)
            if now >= next_stall_check:
                try:
                    self.check_stalls()
                except Exception:
                    logger.exception("The stall check failed")
                next_stall_check = time.monotonic() + STALL_CHECK_S
            self._wake.clear()
            with self._requests:
                due = self._sync_due if self._sync_due is not None else math.inf
            wake_at = min(next_sync, next_stall_check, due)
            self._wake.wait(max(0.0, min(wake_at - time.monotonic(), STOP_POLL_S)))

    def shutdown(self) -> None:
        """Stops every worker with end_reason engine_stop, all at once (each stop() waits up to 10 s)."""
        with self._lock:
            self._closed = True
            workers, self.workers = self.workers, {}
        deadline = time.monotonic() + SHUTDOWN_S
        stoppers = [threading.Thread(target=w.stop, args=("engine_stop", SHUTDOWN_S), name=f"stop-{c}", daemon=True)
                    for c, w in workers.items()]
        for t in stoppers:
            t.start()
        for t in stoppers:
            t.join(max(0.0, deadline - time.monotonic()) + 1.0)
        for camera_id in workers:
            self._notify_stop(camera_id)

    def _safe_sync(self) -> bool:
        try:
            return self.sync()
        except Exception:
            logger.exception("The config sync failed")
            return False

    def _start(self, config: CameraConfig, *, restarts: int = 0, rejected: Iterable[int] = ()) -> CameraWorker:
        """Under _lock."""
        worker = self.worker_factory(config, self.deps, clock=self.clock)
        worker.restarts = restarts
        worker.rejected_versions.update(rejected)  # already reported: a restart doesn't report them again
        worker.start()
        self.workers = {**self.workers, config.id: worker}
        return worker

    def _stop(self, worker: CameraWorker, end_reason: str) -> None:
        """Under _lock."""
        try:
            worker.stop(end_reason)
        except Exception:
            logger.exception("[%s] Stopping the worker failed", worker.id)
        self._notify_stop(worker.id)

    def _notify_stop(self, camera_id: str) -> None:
        try:
            self.on_stop(camera_id)
        except Exception:
            logger.exception("[%s] on_stop failed", camera_id)
