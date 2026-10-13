import json
import os
import time

import pytest
import redis
from conftest import FakeYOLO, wait_until
from core.model_jobs import ModelJobs
from test_model_jobs import RecordingApi

pytestmark = pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs REDIS_URL")


def test_a_queued_job_is_taken_once_and_stop_ends_the_threads(tmp_path):
    FakeYOLO.reset()
    queue = f"model:jobs-test-{time.time_ns()}"
    client = redis.Redis.from_url(os.environ["REDIS_URL"], socket_timeout=10)
    api = RecordingApi()
    threads = [ModelJobs(redis.Redis.from_url(os.environ["REDIS_URL"], socket_timeout=10), api, str(tmp_path),
                         "cpu", loader=FakeYOLO, queue=queue) for _ in range(2)]
    for t in threads:
        t.start()
    try:
        client.lpush(queue, json.dumps({"type": "validate", "modelId": "m1", "path": "a.onnx"}))
        assert wait_until(lambda: len(api.validations) == 1, 10)
        time.sleep(0.3)
        assert len(api.validations) == 1
    finally:
        for t in threads:
            t.stop()
        for t in threads:
            t.join(10)
        client.close()
    assert not any(t.is_alive() for t in threads)
