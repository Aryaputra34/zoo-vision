"""Sends contract-checked messages to the Redis stream without ever blocking a camera thread."""

import json
import logging
import threading
from collections import deque

import redis
import redis.exceptions

from core.messages import ContractError, event_message, validate

log = logging.getLogger(__name__)

_BACKOFF_START, _BACKOFF_MAX = 0.5, 5.0


class EventStream:
    """`send` validates and enqueues; a worker thread does XADD, oldest first.

    While Redis is unreachable the messages wait in a bounded buffer. When it is full the oldest message is
    dropped and counted; after the next successful XADD the count goes out as an `events_dropped` event.
    """

    def __init__(self, redis_url: str | None = None, *, client=None, stream: str = "events",
                 maxlen: int = 1_000_000, buffer_size: int = 10_000, engine_group: str = "default"):
        if client is None:
            if not redis_url:
                raise ValueError("EventStream needs a redis_url or a client")
            client = redis.Redis.from_url(redis_url, socket_timeout=5, socket_connect_timeout=5)
        self._client = client
        self._stream, self._maxlen, self._buffer_size, self._engine_group = stream, maxlen, buffer_size, engine_group
        self._queue: deque[dict] = deque()
        self._cond = threading.Condition()
        self._stopping = False
        self._abort = threading.Event()
        self._unreported = 0
        self.dropped_total = 0
        self._worker = threading.Thread(target=self._run, name="event-stream", daemon=True)
        self._worker.start()

    def send(self, message: dict) -> None:
        try:
            validate(message)
        except ContractError as e:
            log.error("contract violation, message dropped: %s", e)
            return
        except Exception:
            log.exception("contract check crashed, message dropped")
            return
        with self._cond:
            self._enqueue(message)
            self._cond.notify()

    def stop(self, timeout: float = 5.0) -> None:
        with self._cond:
            self._stopping = True
            self._cond.notify_all()
        self._worker.join(timeout)
        if self._worker.is_alive():
            self._abort.set()
            self._worker.join(1.0)
        with self._cond:
            left = len(self._queue)
        if left:
            log.warning("event stream stopped with %d undelivered message(s)", left)

    def _enqueue(self, message: dict) -> None:
        """Caller holds the lock."""
        if len(self._queue) >= self._buffer_size:
            self._queue.popleft()
            self.dropped_total += 1
            self._unreported += 1
        self._queue.append(message)

    def _run(self) -> None:
        backoff, outage = _BACKOFF_START, False
        while not self._abort.is_set():
            with self._cond:
                while not self._queue and not self._stopping:
                    self._cond.wait()
                if not self._queue:
                    return
                message = self._queue.popleft()
            try:
                self._client.xadd(self._stream, {"msg": json.dumps(message, separators=(",", ":"))},
                                  maxlen=self._maxlen, approximate=True)
            except (redis.exceptions.ConnectionError, redis.exceptions.TimeoutError) as e:
                with self._cond:
                    if len(self._queue) < self._buffer_size:
                        self._queue.appendleft(message)
                    else:  # send() filled the buffer meanwhile; this is the oldest message
                        self.dropped_total += 1
                        self._unreported += 1
                if not outage:
                    log.warning("Redis unreachable, buffering events: %s", e)
                    outage = True
                self._abort.wait(backoff)
                backoff = min(backoff * 2, _BACKOFF_MAX)
                continue
            except Exception:
                log.exception("XADD failed, message dropped")
                continue
            if outage:
                log.info("Redis reachable again, %d buffered message(s) to send", len(self._queue))
            backoff, outage = _BACKOFF_START, False
            self._report_drops()

    def _report_drops(self) -> None:
        with self._cond:
            count, self._unreported = self._unreported, 0
            if not count:
                return
            self._enqueue(event_message(None, "system", "events_dropped",
                                        {"engineGroup": self._engine_group, "count": count}))
        log.warning("%d event(s) were dropped while Redis was unreachable", count)
