"""StatusPublisher without Redis: a fake client that can fail like a Redis outage."""

import threading
import time

import numpy as np
import pytest
import redis
from conftest import wait_until
from core import status as status_module
from core.status import StatusPublisher


class FakeRedis:
    """Records the status hashes written (camera id, fields) and the frames set; raises ConnectionError while
    `down` is set."""

    def __init__(self):
        self.down = False
        self.statuses: list[tuple[str, dict]] = []
        self.frames = 0
        self._lock = threading.Lock()

    def _check(self):
        if self.down:
            raise redis.ConnectionError("Redis is down")

    def pipeline(self, transaction=False):
        outer, ops = self, []

        class Pipe:
            def hset(self, key, mapping):
                ops.append((key, mapping))

            def pexpireat(self, key, when):
                pass

            def execute(self):
                outer._check()
                with outer._lock:
                    outer.statuses += [(key.split(":")[1], fields) for key, fields in ops]

        return Pipe()

    def set(self, key, value, px=None):
        self._check()
        with self._lock:
            self.frames += 1

    def delete(self, key):
        self._check()

    def written(self, camera_id: str) -> int:
        with self._lock:
            return sum(1 for c, _ in self.statuses if c == camera_id)


class Worker:
    """A running camera whose last frame is always fresh (so every frame round has a new frame to write)."""

    def __init__(self, camera_id, live=None, fps=4.9):
        self.id, self.state, self.fps, self.restarts = camera_id, "running", fps, 0
        self.applied_version, self.config_error = 3, None
        self.started_at = time.time() - 60
        self.latest_raw = np.zeros((8, 8, 3), np.uint8)
        self.config = type("Config", (), {"use_case": "vehicle_gate"})()
        self.pipeline = type("Pipeline", (), {"live": live if live is not None else {"inCount": 1}})()

    @property
    def last_frame_at(self):
        return time.time() - 0.05


@pytest.fixture
def publisher():
    made = []

    def make(r, workers):
        p = StatusPublisher(r, lambda: workers, engine_group="park", boot_id="boot1")
        made.append(p)
        return p

    yield make
    for p in made:
        p.stop()
        p.join(5)


def test_statuses_are_republished_at_once_when_redis_is_back(publisher, monkeypatch):
    monkeypatch.setattr(status_module, "STATUS_EVERY_S", 30.0)  # no heartbeat during the test
    monkeypatch.setattr(status_module, "FRAME_EVERY_S", 0.05)
    monkeypatch.setattr(status_module, "TICK_S", 0.02)
    r = FakeRedis()
    p = publisher(r, [Worker("a"), Worker("b")])
    p.start()
    assert wait_until(lambda: r.written("a") == 1 and r.written("b") == 1)  # the first heartbeat
    r.down = True
    assert wait_until(lambda: p._failing)  # a frame write failed
    r.down = False  # the frame round is the first to succeed again
    assert wait_until(lambda: r.written("a") == 2 and r.written("b") == 2, timeout=1.0), \
        "the statuses waited for the next heartbeat; their keys may have expired meanwhile"


def test_one_bad_worker_does_not_hold_up_the_others(caplog):
    r = FakeRedis()
    bad = Worker("bad", fps=None)  # f"{None:.1f}" raises
    odd = Worker("odd", live={"inCount": np.int64(3), "since": object()})  # not JSON by itself
    good = Worker("good")
    p = StatusPublisher(r, lambda: [bad, odd, good], engine_group="park", boot_id="boot1")
    p.publish_status(time.time())
    assert r.written("good") == 1 and r.written("bad") == 0
    [(_, fields)] = [s for s in r.statuses if s[0] == "odd"]
    assert fields["live"].startswith('{"inCount": "3", "since": "<object object')
    assert "[bad] Could not publish the status" in caplog.text
    assert not p._changed()  # the bad camera is not retried at every tick
    p.publish_status(time.time())  # the next heartbeat tries again, without logging again
    assert r.written("good") == 2 and caplog.text.count("[bad] Could not publish") == 1


def test_a_redis_outage_still_reaches_the_guard():
    r = FakeRedis()
    r.down = True
    p = StatusPublisher(r, lambda: [Worker("a")], engine_group="park", boot_id="boot1")
    with pytest.raises(redis.ConnectionError):
        p.publish_status(time.time())  # _guard logs it once and retries every round
