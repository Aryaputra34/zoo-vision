import json
import os
import uuid

import pytest
import redis
from core.event_stream import EventStream
from core.messages import event_message, validate

pytestmark = pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs REDIS_URL")


def test_messages_land_in_the_stream():
    name = f"events-test-{uuid.uuid4().hex}"
    s = EventStream(os.environ["REDIS_URL"], stream=name)
    s.send(event_message(None, "system", "engine_started", {"bootId": uuid.uuid4().hex, "engineGroup": "default"}))
    s.stop()
    r = redis.Redis.from_url(os.environ["REDIS_URL"])
    [(_, fields)] = r.xrange(name)
    validate(json.loads(fields[b"msg"]))
    r.delete(name)
