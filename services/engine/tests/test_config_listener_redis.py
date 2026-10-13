import os
import threading
import time

import pytest
import redis
from core.config_listener import ConfigListener

pytestmark = pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs REDIS_URL")


class Counter:
    def __init__(self):
        self.n = 0
        self._cond = threading.Condition()

    def __call__(self):
        with self._cond:
            self.n += 1
            self._cond.notify_all()

    def wait_for(self, n, timeout=10.0):
        with self._cond:
            return self._cond.wait_for(lambda: self.n >= n, timeout)


@pytest.fixture
def listener():
    made = []

    def start(channel):
        client = redis.Redis.from_url(os.environ["REDIS_URL"])
        counter = Counter()
        lst = ConfigListener(client, counter, channel=channel)
        lst.start()
        made.append((lst, client))
        return lst, counter, client

    yield start
    for lst, client in made:
        lst.stop()
        lst.join(5)
        assert not lst.is_alive()
        client.close()


def test_subscribe_triggers_a_sync_and_every_notice_another(listener):
    lst, counter, client = listener("cfg:test-notice")
    assert counter.wait_for(1)
    client.publish("cfg:test-notice", '{"cameraId": "c", "version": 2}')
    assert counter.wait_for(2)
    client.publish("cfg:test-notice", "not even json")
    assert counter.wait_for(3)


def test_a_dropped_connection_resubscribes_and_triggers_a_sync(listener):
    lst, counter, client = listener("cfg:test-drop")
    assert counter.wait_for(1)
    deadline = time.monotonic() + 10
    while counter.n < 2 and time.monotonic() < deadline:
        client.client_kill_filter(_type="pubsub")
        counter.wait_for(2, timeout=1.0)
    assert counter.n >= 2, "no resync after the connection was dropped"
    before = counter.n
    client.publish("cfg:test-drop", "{}")  # the new subscription works
    assert counter.wait_for(before + 1)
