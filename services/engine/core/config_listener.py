"""Tells the supervisor to resync whenever the API publishes on `cfg:changed`, and after every (re)subscribe.

The notice itself is only a trigger (its content is ignored): the supervisor refetches the whole snapshot. A
notice published while the connection was down is lost, so each successful subscribe triggers a resync too.
"""

import logging
import threading
from typing import Callable

import redis

logger = logging.getLogger("ConfigListener")

BACKOFF_START_S, BACKOFF_MAX_S = 0.5, 5.0
POLL_S = 1.0  # how quickly the thread notices stop()


class ConfigListener(threading.Thread):
    def __init__(self, redis_client, on_change: Callable[[], None], *, channel: str = "cfg:changed"):
        super().__init__(name="config-listener", daemon=True)
        self._client, self._on_change, self._channel = redis_client, on_change, channel
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        backoff = BACKOFF_START_S
        down = False
        while not self._stop_event.is_set():
            pubsub = None
            try:
                pubsub = self._client.pubsub()
                pubsub.subscribe(self._channel)
                while not self._stop_event.is_set():
                    message = pubsub.get_message(timeout=POLL_S)
                    if message is None:
                        continue
                    if message["type"] == "subscribe":  # also after redis-py reconnected by itself
                        if down:
                            logger.info("Subscribed to %s again", self._channel)
                            down = False
                        backoff = BACKOFF_START_S
                    elif message["type"] != "message":
                        continue
                    self._trigger()
            except redis.RedisError as e:
                if not down:
                    logger.warning("Lost the %s subscription (%s); retrying", self._channel, type(e).__name__)
                    down = True
                self._stop_event.wait(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
            finally:
                if pubsub is not None:
                    try:
                        pubsub.close()
                    except redis.RedisError:
                        pass

    def _trigger(self) -> None:
        try:
            self._on_change()
        except Exception:
            logger.exception("The change handler failed")
