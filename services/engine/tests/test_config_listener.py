"""ConfigListener without Redis: an unexpected error is logged and the listener subscribes again."""

import logging
import threading

import pytest
from conftest import wait_until
from core import config_listener as cl
from core.config_listener import ConfigListener


class FakePubSub:
    def __init__(self):
        self._subscribed = False

    def subscribe(self, channel):
        self._subscribed = True

    def get_message(self, timeout):
        if self._subscribed:
            self._subscribed = False
            return {"type": "subscribe", "channel": b"cfg:changed", "data": 1}
        threading.Event().wait(min(timeout, 0.05))
        return None

    def close(self):
        pass


class FlakyClient:
    """pubsub() raises a non-Redis error `failures` times, then works."""

    def __init__(self, failures):
        self.failures = failures

    def pubsub(self):
        if self.failures:
            self.failures -= 1
            raise ValueError("an unexpected bug")
        return FakePubSub()


@pytest.fixture
def listeners():
    made = []
    yield made
    for lst in made:
        lst.stop()
        lst.join(5)
        assert not lst.is_alive()


def test_an_unexpected_error_is_logged_and_the_listener_carries_on(listeners, monkeypatch, caplog):
    monkeypatch.setattr(cl, "BACKOFF_START_S", 0.05)
    caplog.set_level(logging.WARNING)
    triggers = []
    lst = ConfigListener(FlakyClient(failures=2), lambda: triggers.append(1))
    listeners.append(lst)
    lst.start()
    assert wait_until(lambda: triggers == [1])  # subscribed after two failures: a resync
    assert lst.is_alive()
    assert "ValueError" in caplog.text or "an unexpected bug" in caplog.text
