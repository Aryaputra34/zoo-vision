import json
import logging
import time

import pytest
import redis.exceptions
from core.event_stream import EventStream
from core.messages import event_message


class FakeRedis:
    def __init__(self):
        self.entries = []
        self.down = False

    def xadd(self, name, fields, maxlen=None, approximate=True):
        if self.down:
            raise redis.exceptions.ConnectionError("down")
        self.entries.append((name, fields, maxlen, approximate))

    @property
    def types(self):
        return [json.loads(f["msg"])["type"] for _, f, _, _ in self.entries]


def wait_until(cond, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.005)
    return cond()


def started():
    return event_message(None, "system", "engine_started", {"bootId": "0" * 32, "engineGroup": "default"})


def dropped(group, count):
    return event_message(None, "system", "events_dropped", {"engineGroup": group, "count": count})


@pytest.fixture
def fake():
    return FakeRedis()


def make(fake, **kw):
    return EventStream(client=fake, **kw)


def test_one_xadd_per_message_with_capped_length(fake):
    es = make(fake)
    es.send(started())
    assert wait_until(lambda: len(fake.entries) == 1)
    es.stop()
    name, fields, maxlen, approximate = fake.entries[0]
    assert (name, maxlen, approximate) == ("events", 1_000_000, True)
    assert list(fields) == ["msg"] and ": " not in fields["msg"]
    assert json.loads(fields["msg"])["type"] == "engine_started"


def test_buffers_while_redis_is_down_and_keeps_order(fake):
    fake.down = True
    es = make(fake)
    es.send(started())
    es.send(dropped("g", 1))
    es.send(started())
    time.sleep(0.2)
    assert fake.entries == []
    fake.down = False
    assert wait_until(lambda: len(fake.entries) == 3, timeout=3.0)
    es.stop()
    assert fake.types == ["engine_started", "events_dropped", "engine_started"]


def test_full_buffer_drops_oldest_and_reports_the_count(fake):
    fake.down = True
    es = make(fake, buffer_size=2, engine_group="g1")
    es.send(dropped("m1", 1))
    es.send(dropped("m2", 1))
    es.send(dropped("m3", 1))
    assert es.dropped_total == 1
    fake.down = False
    assert wait_until(lambda: len(fake.entries) == 3, timeout=3.0)
    es.stop()
    sent = [json.loads(f["msg"]) for _, f, _, _ in fake.entries]
    assert [m["data"]["engineGroup"] for m in sent] == ["m2", "m3", "g1"]
    assert sent[2]["type"] == "events_dropped" and sent[2]["data"] == {"engineGroup": "g1", "count": 1}
    assert sent[2]["useCase"] == "system" and sent[2]["cameraId"] is None


def test_send_never_blocks_while_redis_is_down(fake):
    fake.down = True
    es = make(fake)
    t0 = time.monotonic()
    for _ in range(1000):
        es.send(started())
    assert time.monotonic() - t0 < 0.5
    es.stop(timeout=0.1)


def test_invalid_message_is_logged_and_never_sent(fake, caplog):
    es = make(fake)
    with caplog.at_level(logging.ERROR):
        es.send({"message": "event"})
    es.stop()
    assert fake.entries == []
    assert any(r.levelno == logging.ERROR and "contract" in r.getMessage().lower() for r in caplog.records)


def test_stop_reports_undelivered_messages(fake, caplog):
    fake.down = True
    es = make(fake)
    es.send(started())
    with caplog.at_level(logging.WARNING):
        es.stop(timeout=0.1)
    assert any("undelivered" in r.getMessage() and "1" in r.getMessage() for r in caplog.records)
