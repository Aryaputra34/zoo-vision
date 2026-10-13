"""
Shared model pool. Camera workers that use the same (model file, imgsz) share one loaded model.
Each loaded model has one inference thread, so the model object is only ever called from that thread.
A pipeline holds a handle and calls it like `ultralytics.YOLO` for one frame: `handle(frame, **kwargs)[0]`.

Locking:
  * `ModelPool._lock` guards the entries map, ref counts and the closed flag. It is never held while a
    model loads, while a thread is joined, or while a caller waits for a result.
  * `_Entry.lock` makes "check not stopping, then enqueue" atomic against "mark stopping, then enqueue
    the stop sentinel". So nothing is ever queued behind the sentinel, and every request queued before
    it is answered by the thread before it exits.
"""

import queue
import threading
from typing import Any, Callable, Optional, Protocol, Union

from core.model_store import resolve_model_path

ImgSize = Union[int, tuple]
_STOP = object()


class Detector(Protocol):
    """What a pipeline holds as self.model."""

    names: dict

    def __call__(self, source, **kwargs) -> list: ...


class _Request:
    __slots__ = ("frame", "kwargs", "done", "result", "error")

    def __init__(self, frame, kwargs):
        self.frame, self.kwargs = frame, kwargs
        self.done = threading.Event()
        self.result: Any = None
        self.error: Optional[BaseException] = None

    def finish(self, result=None, error=None):
        self.result, self.error = result, error
        self.done.set()


class _Entry:
    def __init__(self, key, max_batch: int):
        self.key, self.max_batch = key, max_batch
        self.refs = 0
        self.ready = threading.Event()  # set when loading finished (successfully or not)
        self.load_error: Optional[BaseException] = None
        self.model: Any = None
        self.names: dict = {}
        self.queue: "queue.Queue" = queue.Queue()
        self.lock = threading.Lock()
        self.stopping = False
        self.thread: Optional[threading.Thread] = None

    def start(self):
        self.thread = threading.Thread(target=self._run, name=f"model-{self.key[0]}", daemon=True)
        self.thread.start()

    def submit(self, request: _Request):
        with self.lock:
            if self.stopping:
                raise RuntimeError("The model was released")
            self.queue.put(request)

    def stop(self):
        with self.lock:
            if self.stopping:
                return
            self.stopping = True
            self.queue.put(_STOP)
        if self.thread is not None:
            self.thread.join()
        self.model = None

    def _run(self):
        carry = None
        stop = False
        while not stop:
            first = carry if carry is not None else self.queue.get()
            carry = None
            if first is _STOP:
                return
            batch = [first]
            while len(batch) < self.max_batch:
                try:
                    nxt = self.queue.get_nowait()
                except queue.Empty:
                    break
                if nxt is _STOP:
                    stop = True
                    break
                if nxt.kwargs != first.kwargs:
                    carry = nxt
                    break
                batch.append(nxt)
            self._infer(batch)

    def _infer(self, batch):
        try:
            results = self.model([r.frame for r in batch], **batch[0].kwargs)
            if len(results) != len(batch):
                raise RuntimeError(f"The model returned {len(results)} results for {len(batch)} frames")
        except BaseException as e:
            for r in batch:
                r.finish(error=e)
            return
        for r, res in zip(batch, results):
            r.finish(result=[res])


class _Handle:
    """What `acquire` returns; calls the entry's model through its thread."""

    def __init__(self, entry: _Entry, call_timeout: float):
        self._entry, self._call_timeout = entry, call_timeout
        self.released = False

    @property
    def names(self) -> dict:
        return self._entry.names

    def __call__(self, source, **kwargs) -> list:
        request = _Request(source, kwargs)
        self._entry.submit(request)
        if not request.done.wait(self._call_timeout):
            raise TimeoutError(f"No answer from the model within {self._call_timeout} s")
        if request.error is not None:
            raise request.error
        return request.result


def _normalize_imgsz(imgsz) -> ImgSize:
    return tuple(imgsz) if isinstance(imgsz, (list, tuple)) else imgsz


class ModelPool:
    def __init__(self, device: str, models_dir: Optional[str] = None, *, max_batch: int = 1,
                 call_timeout: float = 30.0, loader: Optional[Callable[..., Any]] = None):
        self.device, self.models_dir = device, models_dir
        self.max_batch, self.call_timeout = max(1, max_batch), call_timeout
        if loader is None:
            from ultralytics import YOLO as loader
        self._loader = loader
        self._lock = threading.Lock()
        self._entries: dict = {}
        self._closed = False

    def acquire(self, path: str, imgsz: ImgSize) -> Detector:
        key = (resolve_model_path(path, self.models_dir), _normalize_imgsz(imgsz))
        with self._lock:
            if self._closed:
                raise RuntimeError("The model pool is closed")
            entry = self._entries.get(key)
            creator = entry is None
            if creator:
                entry = self._entries[key] = _Entry(key, self.max_batch)
            entry.refs += 1
        if creator:
            self._load(entry)
        else:
            entry.ready.wait()
            if entry.load_error is not None:
                raise entry.load_error
        return _Handle(entry, self.call_timeout)

    def _load(self, entry: _Entry):
        try:
            entry.model = self._loader(entry.key[0], task="detect")
            entry.names = entry.model.names
            with self._lock:
                if self._closed:
                    raise RuntimeError("The model pool is closed")
                entry.start()
        except BaseException as e:
            with self._lock:
                if self._entries.get(entry.key) is entry:
                    del self._entries[entry.key]
            entry.load_error, entry.model = e, None
            entry.ready.set()
            raise
        entry.ready.set()

    def release(self, detector: Detector) -> None:
        if not isinstance(detector, _Handle):
            raise TypeError("release expects a handle returned by acquire")
        stop = None
        with self._lock:
            if detector.released:
                return
            detector.released = True
            entry = detector._entry
            entry.refs -= 1
            if entry.refs == 0 and self._entries.get(entry.key) is entry:
                del self._entries[entry.key]
                stop = entry
        if stop is not None:
            stop.stop()

    def loaded(self) -> list:
        with self._lock:
            return [k for k, e in self._entries.items() if e.ready.is_set() and e.load_error is None]

    def close(self) -> None:
        with self._lock:
            self._closed = True
            entries = [e for e in self._entries.values() if e.thread is not None]
            self._entries.clear()
        for e in entries:
            e.stop()
