"""
Keeps one CameraWorker per camera of the API's snapshot, and restarts the ones that stall.

Threads: run() is the supervisor's thread. It syncs (fetch, then reconcile) at once, on request and every resync_sec,
and checks for stalls every second. request_sync() may be called from any thread (the cfg:changed listener): it only
sets a deadline. reconcile(), check_stalls() and shutdown() decide under `_lock` and take the workers they stop out
of `workers` there; the stops themselves run after the lock is released, all at once, each followed by on_stop. So a
slow stop never holds up another camera, and a worker being stopped is never in `workers`. `workers` is replaced,
never changed in place, so readers in other threads (pipelines(), the status publisher) get a consistent snapshot
without the lock.
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
FIRST_SYNC_RETRY_MAX_S = 5.0  # ... but only up to 5 s until the API answered once (a late API at first boot)
STOP_POLL_S = 0.1  # how quickly run() notices its stop event
WORKER_STOP_S = 10.0  # CameraWorker.stop's wait for its thread


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

    def reconcile(self, configs: list[CameraConfig], keep: Iterable[str] = ()) -> None:
        """Starts the workers of new cameras, stops the ones no longer listed (config_change), updates the rest. A
        camera in `keep` (its snapshot entry did not parse) is left as it is."""
        wanted: dict[str, CameraConfig] = {}
        for config in configs:
            if config.id in wanted:
                logger.warning("[%s] The camera is listed twice; using its last entry", config.id)
            wanted[config.id] = config
        listed = set(wanted) | set(keep)
        with self._lock:
            if self._closed:
                return
            removed = [w for c, w in self.workers.items() if c not in listed]
            self.workers = {c: w for c, w in self.workers.items() if c in listed}
            for worker in removed:
                logger.info("[%s] Camera removed from the snapshot: stopping it", worker.id)
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
        self._stop_workers(removed, "config_change")

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
        self.reconcile(configs, keep=getattr(configs, "skipped_ids", ()))
        return True

    def request_sync(self) -> None:
        """Thread-safe. Runs a sync debounce_sec from now; requests made before it runs join it."""
        with self._requests:
            if self._sync_due is None:
                self._sync_due = time.monotonic() + self.debounce_sec
        self._wake.set()

    def check_stalls(self) -> None:
        """Stops (engine_stop) and restarts every stalled worker, and every worker whose thread died more than
        stall_sec ago; the new worker's restarts is one more. Such a worker leaves `workers` before it is stopped,
        and its successor joins after the stop and on_stop."""
        now = self.clock()
        with self._lock:
            if self._closed:
                return
            dead = [w for w in self.workers.values() if w.died(now, self.stall_sec)]
            hung = [w for w in self.workers.values() if w not in dead and w.stalled(now, self.stall_sec)]
            stalled = dead + hung
            self.workers = {c: w for c, w in self.workers.items() if w not in stalled}
        for worker in dead:
            logger.warning("[%s] The camera worker ended on an error: restarting the camera", worker.id)
        for worker in hung:
            logger.warning("[%s] The stream delivers but no frame was processed for %.0f s: restarting the camera",
                           worker.id, self.stall_sec)
        self._stop_workers(stalled, "engine_stop")
        with self._lock:
            for worker in stalled:
                if self._closed or worker.id in self.workers:  # shut down, or started again meanwhile
                    continue
                start_from = worker.restart_config()
                try:
                    successor = self._start(start_from, restarts=worker.restarts + 1,
                                            rejected=worker.rejected_versions)
                    if start_from != worker.config:
                        successor.update(worker.config)
                except Exception:  # the camera is out of `workers`, so the next sync starts it again
                    logger.exception("[%s] Could not restart the camera", worker.id)

    def run(self, stop: threading.Event) -> None:
        """Syncs at once, then on request or every resync_sec (sooner while the API gives no answer: 1 s, doubling
        to 5 s until it answered once, then to resync_sec); checks for stalls every second. Returns once `stop` is
        set."""
        next_sync = time.monotonic()
        next_stall_check = next_sync + STALL_CHECK_S
        retry = RETRY_MIN_S
        retry_max = min(FIRST_SYNC_RETRY_MAX_S, self.resync_sec)
        while not stop.is_set():
            now = time.monotonic()
            with self._requests:
                due_now = now >= next_sync or (self._sync_due is not None and now >= self._sync_due)
                if due_now:
                    self._sync_due = None  # this fetch starts after every request made so far
            if due_now:
                if self._safe_sync():
                    retry, retry_max = RETRY_MIN_S, self.resync_sec
                    next_sync = time.monotonic() + self.resync_sec
                else:
                    next_sync = time.monotonic() + min(retry, retry_max)
                    retry = min(retry * 2, retry_max)
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
            workers, self.workers = list(self.workers.values()), {}
        self._stop_workers(workers, "engine_stop")

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

    def _stop_workers(self, workers: list[CameraWorker], end_reason: str) -> None:
        """Not under _lock (the workers are already out of `workers`). Stops them all at once, each in its own thread
        and followed by on_stop, and returns when every stop returned (each waits up to WORKER_STOP_S)."""
        if not workers:
            return
        stoppers = [threading.Thread(target=self._stop_one, args=(w, end_reason), name=f"stop-{w.id}", daemon=True)
                    for w in workers]
        for t in stoppers:
            t.start()
        deadline = time.monotonic() + WORKER_STOP_S + 1.0
        for t in stoppers:
            t.join(max(0.0, deadline - time.monotonic()))

    def _stop_one(self, worker: CameraWorker, end_reason: str) -> None:
        try:
            worker.stop(end_reason, WORKER_STOP_S)
        except Exception:
            logger.exception("[%s] Stopping the worker failed", worker.id)
        try:
            self.on_stop(worker.id)
        except Exception:
            logger.exception("[%s] on_stop failed", worker.id)
