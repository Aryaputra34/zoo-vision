"""
One camera's worker: a thread that owns the camera's stream and pipeline and runs frames through it.

Threads, and what each one owns:
  * The worker thread (`cam-<id>`) owns `pipeline`, the stream in use and the detector the pipeline holds. It is the
    only thread that calls the pipeline (run, apply_config, set_model, shutdown) or swaps the stream. Each pass of
    its loop first applies every queued change, then takes one frame.
  * `update()` and `stop()` run in the caller's thread (the supervisor's). update() parses settings (cheap) and never
    waits for a model load or a stream connect: those run in helper threads.
  * Loaders (`cam-<id>-load`) acquire a detector from the pool; stream starters (`cam-<id>-stream`) start a new stream.
    Each hands its result to the worker thread through the queue.

Generations: every settings change (version, use case, model) takes the next settings generation, every stream change
the next stream generation. A helper queues its result only while its generation is still the newest, and the worker
thread checks again before applying it. A stale result is released (detector) or stopped (stream), so a superseded
model load is never run and never leaked. A detector the pipeline gave up is released after the swap.

`_lock` guards the queue, the generations, `_stopping`, `config` and the status fields other threads write. It is never
held while a model loads, a stream starts or stops, or the pipeline runs. `_update_lock` serializes update() and
start() calls; the worker thread and the helpers never take it.
"""

import logging
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Callable

import numpy as np

from core.base_pipeline import BasePipeline, CameraInfo
from core.camera_config import CameraConfig
from core.event_stream import EventStream
from core.messages import event_message
from core.model_pool import ModelPool
from core.settings import SettingsError, parse_settings
from core.snapshot_store import SnapshotStore
from core.stream_manager import StreamManager, mask_url
from nx_integration.nx_client import NxClient
from usecases import create_pipeline

logger = logging.getLogger("CameraWorker")

REASON_MAX = 500  # characters, for config_error and the config_rejected reason
SAME_FRAME_WAIT_S = 0.01  # the stream has no new frame yet
ERROR_WAIT_S = 1.0  # after a pipeline exception
IDLE_WAIT_S = 0.5  # no pipeline or no stream yet; a queued change or stop() wakes the thread at once


@dataclass
class WorkerDeps:
    pool: ModelPool
    events: EventStream | None
    snapshots: SnapshotStore | None
    nx_client: NxClient
    device: str
    stream_factory: Callable[..., Any] = StreamManager  # (source=, camera_id=, target_fps=) -> start/stop/get_frame


class _Settings:
    """A settings change: `config`, its parsed settings and, once loaded, the detector it brings."""

    __slots__ = ("gen", "config", "settings", "detector")

    def __init__(self, gen: int, config: CameraConfig, settings=None):
        self.gen, self.config, self.settings, self.detector = gen, config, settings, None

    @property
    def key(self) -> tuple:
        return _model_key(self.config)


class _Stream:
    __slots__ = ("gen", "stream")

    def __init__(self, gen: int, stream):
        self.gen, self.stream = gen, stream


_IDENTITY = object()  # name or nx_camera_id changed: the worker thread copies them from `config` to the pipeline


def _model_key(config: CameraConfig) -> tuple:
    imgsz = tuple(config.imgsz) if isinstance(config.imgsz, (list, tuple)) else config.imgsz
    return config.model_path, imgsz


def _settings_of(config: CameraConfig) -> tuple:
    """The fields whose change needs a settings change (unlike the stream and identity fields)."""
    return config.use_case, config.version, config.settings, config.model_path, config.imgsz


def _clip(text: str) -> str:
    return text if len(text) <= REASON_MAX else text[: REASON_MAX - 1] + "…"


class CameraWorker:
    def __init__(self, config: CameraConfig, deps: WorkerDeps, *, clock: Callable[[], float] = time.time):
        self.id = config.id
        self.config = config  # the newest config given to start() or update()
        self.pipeline: BasePipeline | None = None
        # starting | running | error | stopped. `reconnecting` is not set here: the status publisher derives it
        # from last_frame_at while the worker is running.
        self.state = "starting"
        self.applied_version: int | None = None
        self.applied_config: CameraConfig | None = None  # the config whose settings the pipeline runs
        self.config_error: str | None = None
        self.rejected_versions: set[int] = set()  # versions already reported with a config_rejected event
        self.restarts = 0  # set by the supervisor's watchdog
        self.started_at = clock()  # start(), then again when the stream of a first pipeline starts
        self.last_frame_at: float | None = None  # when the last frame was processed
        self.fps = 0.0
        self.latest_raw: np.ndarray | None = None  # the last frame taken from the stream, before the pipeline

        self._deps, self._clock = deps, clock
        self._lock = threading.Lock()
        self._update_lock = threading.Lock()
        self._wake = threading.Event()
        self._queue: list = []
        self._settings_gen = 0
        self._settled_gen = 0  # the newest settings generation that was applied or rejected
        self._stream_gen = 0
        self._stream_wanted = False  # the pipeline exists, so a stream was requested
        self._installed_key: tuple | None = None  # the model key of the detector the pipeline holds
        self._error_version: int | None = None  # the version config_error is about
        self._stream = None  # worker thread
        self._detector = None  # worker thread: the handle the pipeline holds
        self._stopping = False
        self._stop_requested = False
        self._end_reason = "config_change"
        self._thread: threading.Thread | None = None
        self._helpers: set[threading.Thread] = set()
        self._cleaned_up = False

    # --- caller's thread -------------------------------------------------------------------------------------

    def start(self) -> None:
        with self._update_lock, self._lock:
            if self._thread is not None or self._stopping:
                return
            self.started_at = self._clock()
            self._settings_gen += 1
            first = _Settings(self._settings_gen, self.config)
            thread = threading.Thread(target=self._run, args=(first,), name=f"cam-{self.id}", daemon=True)
            thread.start()  # recorded once started, under the lock: stop() only ever joins a started thread
            self._thread = thread
        logger.info("[%s] Camera worker started: %s v%d, stream %s at %d fps", self.id, first.config.use_case,
                    first.config.version, mask_url(first.config.source_url), first.config.target_fps)

    def update(self, config: CameraConfig) -> None:
        """Takes a new config for this camera. Returns at once: model loads and stream starts run in helper threads,
        and the worker thread applies their results between two frames."""
        if config.id != self.id:
            raise ValueError(f"camera {config.id} given to the worker of camera {self.id}")
        with self._update_lock:
            stream_gen = None
            with self._lock:
                if self._stopping or config == self.config:
                    return
                old, self.config = self.config, config
                if (config.source_url, config.target_fps) != (old.source_url, old.target_fps) and self._stream_wanted:
                    self._stream_gen += 1
                    stream_gen = self._stream_gen
                if (config.name, config.nx_camera_id) != (old.name, old.nx_camera_id):
                    self._queue.append(_IDENTITY)
                    self._wake.set()
            if stream_gen is not None:
                logger.info("[%s] Stream changed: %s at %d fps", self.id, mask_url(config.source_url),
                            config.target_fps)
                self._spawn("stream", self._start_stream, stream_gen, config.source_url, config.target_fps)
            if _settings_of(config) != _settings_of(old):
                self._request_settings(config)

    def stop(self, end_reason: str = "config_change", timeout: float = 10.0) -> None:
        """Ends the worker thread, which then shuts the pipeline down with `end_reason`, stops the stream and releases
        the detector. Waits up to `timeout` s in all for the worker thread and the helpers. A helper that finishes
        later releases or stops what it brought."""
        deadline = time.monotonic() + timeout
        with self._lock:
            if not self._stopping:
                self._stopping = self._stop_requested = True
                self._end_reason = end_reason
            thread, helpers = self._thread, list(self._helpers)
        self._wake.set()
        if thread is None:
            self._cleanup()  # never started
        elif thread is not threading.current_thread():
            thread.join(max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                logger.warning("[%s] The worker did not stop within %.1f s; it cleans up when its frame ends",
                               self.id, timeout)
        for helper in helpers:
            helper.join(max(0.0, deadline - time.monotonic()))

    def stalled(self, now: float, after: float = 30.0) -> bool:
        """True when the stream delivered a frame within `after` s, the worker started more than `after` s ago, and no
        frame was processed in the last `after` s. `now` is on the clock of the stream's timestamps (epoch)."""
        stream = self._stream
        if stream is None or self._stopping or now - self.started_at <= after:
            return False
        last = self.last_frame_at
        if last is not None and now - last <= after:
            return False
        try:
            frame, timestamp_ms = stream.get_frame()
        except Exception:
            return False
        return frame is not None and now - timestamp_ms / 1000.0 <= after

    def restart_config(self) -> CameraConfig:
        """The config a watchdog restart starts from: the newest one or, when the newest version was rejected, the
        applied version with the newest stream and identity fields (the new worker is then given the newest
        config, which it rejects again)."""
        with self._lock:
            latest, applied = self.config, self.applied_config
            rejected = latest.version in self.rejected_versions
        if applied is None or not rejected or _settings_of(applied) == _settings_of(latest):
            return latest
        return replace(latest, use_case=applied.use_case, version=applied.version, settings=applied.settings,
                       model_path=applied.model_path, imgsz=applied.imgsz)

    def _request_settings(self, config: CameraConfig) -> None:
        """Caller's thread, under _update_lock. An invalid version is rejected at once and supersedes nothing."""
        try:
            settings = parse_settings(config.use_case, config.settings, strict=True)
        except SettingsError as e:
            self._reject(config, str(e))
            return
        with self._lock:
            self._settings_gen += 1
            change = _Settings(self._settings_gen, config, settings)
            ready = not self._needs_detector(change)
            if ready:
                self._queue.append(change)
                self._wake.set()
        if not ready:
            self._spawn("load", self._prepare, change)

    # --- helper threads (and the worker thread for the first config) ------------------------------------------

    def _prepare(self, change: _Settings) -> None:
        """Parses (if not done yet) and acquires the detector, then queues the change; or rejects its version."""
        config = change.config
        if change.settings is None:
            try:
                change.settings = parse_settings(config.use_case, config.settings, strict=True)
            except SettingsError as e:
                self._reject(config, str(e), gen=change.gen)
                return
        if not self._is_current(change):
            return  # superseded before its load started
        try:
            change.detector = self._deps.pool.acquire(config.model_path, config.imgsz)
        except Exception as e:
            pointer = "/model_id" if "model_id" in config.settings else "/model_name"
            self._reject(config, f"{pointer}: could not load model {config.model_path}: {type(e).__name__}: {e}",
                         gen=change.gen)
            return
        with self._lock:
            queued = self._is_current_locked(change)
            if queued:
                self._queue.append(change)
        if queued:
            self._wake.set()
        else:
            self._release(change.detector)  # a newer change was requested meanwhile, or the worker stopped

    def _start_stream(self, gen: int, source: str, target_fps: int) -> None:
        try:
            stream = self._deps.stream_factory(source=source, camera_id=self.id, target_fps=target_fps)
            stream.start()
        except Exception as e:  # the message may hold the URL: log its type only
            logger.error("[%s] Could not start the stream %s: %s", self.id, mask_url(source), type(e).__name__)
            return
        with self._lock:
            queued = not self._stopping and gen == self._stream_gen
            if queued:
                self._queue.append(_Stream(gen, stream))
        if queued:
            self._wake.set()
        else:
            self._stop_stream(stream)

    def _spawn(self, kind: str, target: Callable, *args) -> None:
        """Runs target(*args) in a helper thread, unless the worker is stopping (then nothing was acquired yet)."""
        thread = threading.Thread(target=self._helper, args=(target, args), name=f"cam-{self.id}-{kind}", daemon=True)
        with self._lock:
            if self._stopping:
                return
            # recorded once started, under the lock: stop() only ever joins a started thread, and the helper's
            # own discard (which needs the lock) always comes after the add
            thread.start()
            self._helpers.add(thread)

    def _helper(self, target: Callable, args: tuple) -> None:
        try:
            target(*args)
        except Exception:
            logger.exception("[%s] Camera worker helper failed", self.id)
        finally:
            with self._lock:
                self._helpers.discard(threading.current_thread())

    def _reject(self, config: CameraConfig, reason: str, gen: int | None = None) -> None:
        """Records a rejected version (config_error, one config_rejected event per version). A change superseded
        meanwhile (`gen` no longer the newest) is not reported: it would not have run anyway. `gen` is None for
        settings update() could not parse: they took no generation, so a valid change in flight still lands."""
        reason = _clip(reason)
        with self._lock:
            superseded = self._stopping or (gen is not None and gen != self._settings_gen)
            if not superseded:
                self.config_error = _clip(f"v{config.version} rejected: {reason}")
                self._error_version = config.version
                first = config.version not in self.rejected_versions
                self.rejected_versions.add(config.version)
                if gen is not None:
                    self._settled_gen = gen
                if self.pipeline is None and self._settled_gen == self._settings_gen:  # nothing valid in flight
                    self.state = "error"
        if superseded:
            logger.info("[%s] v%d was superseded before it could run (%s)", self.id, config.version, reason)
            return
        logger.warning("[%s] Config v%d rejected: %s", self.id, config.version, reason)
        if first and self._deps.events is not None:
            self._deps.events.send(event_message(
                self.id, "system", "config_rejected", {"version": config.version, "reason": reason}, "warning"))

    def _is_current(self, change: _Settings) -> bool:
        with self._lock:
            return self._is_current_locked(change)

    def _is_current_locked(self, change: _Settings) -> bool:
        return not self._stopping and change.gen == self._settings_gen

    def _needs_detector(self, change: _Settings) -> bool:
        """A change needs its own detector for a new pipeline or a new model. Under _lock, or in the worker thread."""
        return (self.pipeline is None or change.config.use_case != self.pipeline.use_case
                or change.key != self._installed_key)

    # --- worker thread -----------------------------------------------------------------------------------------

    def _run(self, first: _Settings) -> None:
        try:
            self._prepare(first)
            self._loop()
        except Exception:
            logger.exception("[%s] Camera worker failed", self.id)
        finally:
            self._cleanup()

    def _loop(self) -> None:
        last_stream, last_ts = None, None
        while not self._stopping:
            self._wake.clear()
            self._apply_queued()
            stream, pipeline = self._stream, self.pipeline
            if self._stopping:
                break
            if stream is None or pipeline is None:
                self._wake.wait(IDLE_WAIT_S)
                continue
            try:
                frame, timestamp_ms = stream.get_frame()
            except Exception as e:
                logger.error("[%s] Reading the stream failed: %s", self.id, type(e).__name__)
                self._wake.wait(ERROR_WAIT_S)
                continue
            # A dead stream keeps returning its last frame: skip it, so YOLO doesn't rerun on it and the camera
            # doesn't look alive
            if frame is None or (stream is last_stream and timestamp_ms == last_ts):
                self._wake.wait(SAME_FRAME_WAIT_S)
                continue
            last_stream, last_ts = stream, timestamp_ms
            self.latest_raw = frame
            try:
                pipeline.run(frame, timestamp_ms)
            except Exception:
                # One camera's failure must not stop the others
                logger.exception("[%s] Pipeline error, skipping frame", self.id)
                self._wake.wait(ERROR_WAIT_S)
                continue
            self._frame_done()

    def _frame_done(self) -> None:
        now = self._clock()
        if self.last_frame_at is not None:
            dt = now - self.last_frame_at
            if 0 < dt < 10:
                self.fps = 1 / dt if not self.fps else 0.9 * self.fps + 0.1 / dt
        self.last_frame_at = now
        if self.state != "running":
            with self._lock:
                if self.state == "starting":
                    self.state = "running"

    def _apply_queued(self) -> None:
        with self._lock:
            queued, self._queue = self._queue, []
        for change in queued:
            try:
                if change is _IDENTITY:
                    self._apply_identity()
                elif isinstance(change, _Stream):
                    self._apply_stream(change)
                else:
                    self._apply_settings(change)
            except Exception:
                logger.exception("[%s] Could not apply a config change", self.id)

    def _apply_identity(self) -> None:
        if self.pipeline is None:
            return  # a new pipeline takes them from `config`
        with self._lock:
            name, nx_camera_id = self.config.name, self.config.nx_camera_id
        self.pipeline.camera_name, self.pipeline.nx_camera_id = name, nx_camera_id

    def _apply_stream(self, change: _Stream) -> None:
        with self._lock:
            current = not self._stopping and change.gen == self._stream_gen
        if not current:
            self._stop_stream(change.stream)
            return
        old, self._stream = self._stream, change.stream
        if old is not None:
            self._stop_stream(old)

    def _apply_settings(self, change: _Settings) -> None:
        if not self._is_current(change):
            self._release(change.detector)
            return
        if change.detector is None and self._needs_detector(change):
            # update() decided before an earlier change swapped the pipeline or its model: load first; the
            # change comes back with its detector
            self._spawn("load", self._prepare, change)
            return
        if self.pipeline is None or change.config.use_case != self.pipeline.use_case:
            self._rebuild(change)
        else:
            self._reconfigure(change)

    def _rebuild(self, change: _Settings) -> None:
        """A first pipeline, or a new one for a new use case. The old pipeline closes with config_change."""
        config, detector = change.config, change.detector
        with self._lock:
            camera = CameraInfo(self.id, self.config.name, self.config.nx_camera_id)
        try:
            pipeline = create_pipeline(camera, config.use_case, change.settings, detector, device=self._deps.device,
                                       nx_client=self._deps.nx_client, config_version=config.version)
            pipeline.events = self._deps.events
            pipeline.snapshots = self._deps.snapshots
        except Exception as e:
            logger.exception("[%s] The %s pipeline failed to start", self.id, config.use_case)
            self._release(detector)
            self._reject(config, f"(document): the {config.use_case} pipeline failed to start: {type(e).__name__}: {e}",
                         gen=change.gen)
            return
        old, old_detector = self.pipeline, self._detector
        if old is not None:
            self._shutdown_pipeline(old, "config_change")
        start = None
        with self._lock:
            self.pipeline, self._detector = pipeline, detector
            self._applied(change)
            if self.state == "error":
                self.state = "starting"
            if not self._stream_wanted:
                self._stream_wanted = True
                self._stream_gen += 1
                self.started_at = self._clock()  # the stall and status clocks run from the stream's start
                start = (self._stream_gen, self.config.source_url, self.config.target_fps)
        self._release(old_detector)
        if start is not None:
            self._spawn("stream", self._start_stream, *start)
        logger.info("[%s] Running %s v%d on model %s", self.id, config.use_case, config.version, config.model_path)

    def _reconfigure(self, change: _Settings) -> None:
        """New settings (and maybe a new detector) for the same pipeline, between two frames."""
        pipeline, config = self.pipeline, change.config
        old_settings, old_version = pipeline.settings, pipeline.config_version
        try:
            pipeline.apply_config(change.settings, config.version)
        except Exception as e:
            logger.exception("[%s] Applying v%d failed; going back to v%s", self.id, config.version, old_version)
            try:
                pipeline.apply_config(old_settings, old_version)
            except Exception:
                logger.exception("[%s] Going back to v%s failed", self.id, old_version)
            self._release(change.detector)
            self._reject(config, f"(document): the settings could not be applied: {type(e).__name__}: {e}",
                         gen=change.gen)
            return
        previous = None
        if change.detector is not None:
            previous = pipeline.set_model(change.detector)
        with self._lock:
            if change.detector is not None:
                self._detector = change.detector
            self._applied(change)
        self._release(previous)  # the pipeline no longer calls it
        logger.info("[%s] Applied v%d", self.id, config.version)

    def _applied(self, change: _Settings) -> None:
        """Under _lock, right after the worker thread installed `change`."""
        self._settled_gen = max(self._settled_gen, change.gen)
        self._installed_key = change.key
        self.applied_config = change.config
        self.applied_version = change.config.version
        if self._error_version is not None and change.config.version >= self._error_version:
            self.config_error = self._error_version = None

    def _cleanup(self) -> None:
        """Runs once: in the worker thread as it ends, or in stop() when the thread never started."""
        with self._lock:
            if self._cleaned_up:
                return
            self._cleaned_up = self._stopping = True
            queued, self._queue = self._queue, []
            # without a stop() request the thread died: its intervals close as at an engine stop
            reason = self._end_reason if self._stop_requested else "engine_stop"
        if self.pipeline is not None:
            self._shutdown_pipeline(self.pipeline, reason)
        if self._stream is not None:
            self._stop_stream(self._stream)
        self._release(self._detector)
        for change in queued:
            if isinstance(change, _Settings):
                self._release(change.detector)
            elif isinstance(change, _Stream):
                self._stop_stream(change.stream)
        with self._lock:
            self.state = "stopped"
        logger.info("[%s] Camera worker stopped (%s)", self.id, reason)

    # --- any thread ----------------------------------------------------------------------------------------------

    def _release(self, detector) -> None:
        if detector is None:
            return
        try:
            self._deps.pool.release(detector)
        except Exception:
            logger.exception("[%s] Releasing a detector failed", self.id)

    def _stop_stream(self, stream) -> None:
        try:
            stream.stop()
        except Exception as e:
            logger.error("[%s] Stopping a stream failed: %s", self.id, type(e).__name__)

    def _shutdown_pipeline(self, pipeline: BasePipeline, end_reason: str) -> None:
        try:
            pipeline.shutdown(end_reason)
        except Exception:
            logger.exception("[%s] Pipeline shutdown failed", self.id)
