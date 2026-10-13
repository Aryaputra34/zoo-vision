import threading
import time

import numpy as np
import pytest

from core.model_pool import ModelPool
from conftest import FakeYOLO


def frame(i: int):
    return np.full((4, 4, 3), i, dtype=np.uint8)


def wait_until(condition, timeout=10.0):
    """Waits for a state the test itself caused (never a sleep standing in for ordering)."""
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition never became true"
        time.sleep(0.005)


def run_in_threads(targets):
    threads = [threading.Thread(target=t, daemon=True) for t in targets]
    for t in threads:
        t.start()
    return threads


@pytest.fixture
def make_pool(fake_yolo, monkeypatch):
    monkeypatch.setattr("core.model_pool.resolve_model_path", lambda name, models_dir=None: name)
    pools = []

    def make(**kwargs):
        pools.append(ModelPool("cpu", loader=FakeYOLO, **kwargs))
        return pools[-1]

    yield make
    FakeYOLO.gate.set()
    FakeYOLO.load_gate.set()
    for p in pools:
        p.close()


def test_same_key_shares_one_model_and_unloads_at_zero(fake_pool):
    pool = fake_pool
    a, b = pool.acquire("m.onnx", 640), pool.acquire("m.onnx", 640)
    assert FakeYOLO.loads == 1 and pool.loaded() == [("m.onnx", 640)]
    pool.release(a)
    assert pool.loaded()
    pool.release(b)
    assert pool.loaded() == []


def test_other_imgsz_is_another_model(fake_pool):
    fake_pool.acquire("m.onnx", 640)
    fake_pool.acquire("m.onnx", 1280)
    assert FakeYOLO.loads == 2
    assert sorted(fake_pool.loaded()) == [("m.onnx", 640), ("m.onnx", 1280)]


def test_list_imgsz_is_normalized_to_a_tuple(fake_pool):
    a = fake_pool.acquire("m.onnx", [640, 640])
    b = fake_pool.acquire("m.onnx", (640, 640))
    assert FakeYOLO.loads == 1
    assert fake_pool.loaded() == [("m.onnx", (640, 640))]
    fake_pool.release(a)
    fake_pool.release(b)


def test_handle_exposes_names_and_wraps_the_result_for_one_frame(fake_pool):
    det = fake_pool.acquire("m.onnx", 640)
    assert det.names[0] == "person"
    result = det(frame(7), conf=0.3)
    assert len(result) == 1 and result[0].orig_img[0, 0, 0] == 7
    assert FakeYOLO.kwargs == [{"conf": 0.3}]


def test_calls_from_many_threads_never_overlap(fake_pool):
    det = fake_pool.acquire("m.onnx", 640)
    got, errors = {}, []

    def worker(w):
        try:
            for n in range(20):
                i = w * 20 + n
                got[i] = det(frame(i))[0].orig_img[0, 0, 0]
        except Exception as e:
            errors.append(e)

    for t in run_in_threads([lambda w=w: worker(w) for w in range(4)]):
        t.join(30)
    assert not errors and len(got) == 80
    assert all(got[i] == i for i in got)
    assert FakeYOLO.overlaps == 0


def test_batches_equal_kwargs_up_to_max_batch(make_pool):
    pool = make_pool(max_batch=3)
    det = pool.acquire("m.onnx", 640)
    FakeYOLO.gate.clear()
    out = {}

    def call(i):
        out[i] = det(frame(i), conf=0.3)[0].orig_img[0, 0, 0]

    first = run_in_threads([lambda: call(0)])
    wait_until(lambda: FakeYOLO.batches == [1])  # call 0 is in flight, blocked on the gate
    rest = run_in_threads([lambda i=i: call(i) for i in (1, 2, 3)])
    wait_until(lambda: det._entry.queue.qsize() == 3)
    FakeYOLO.gate.set()
    for t in first + rest:
        t.join(10)
    assert FakeYOLO.batches == [1, 3]
    assert out == {0: 0, 1: 1, 2: 2, 3: 3}


def test_unequal_kwargs_are_not_batched(make_pool):
    pool = make_pool(max_batch=3)
    det = pool.acquire("m.onnx", 640)
    FakeYOLO.gate.clear()
    first = run_in_threads([lambda: det(frame(0), conf=0.1)])
    wait_until(lambda: FakeYOLO.batches == [1])
    rest = run_in_threads([lambda: det(frame(1), conf=0.3), lambda: det(frame(2), conf=0.5)])
    wait_until(lambda: det._entry.queue.qsize() == 2)
    FakeYOLO.gate.set()
    for t in first + rest:
        t.join(10)
    assert FakeYOLO.batches == [1, 1, 1]


def test_default_max_batch_is_one(fake_pool):
    det = fake_pool.acquire("m.onnx", 640)
    FakeYOLO.gate.clear()
    ts = run_in_threads([lambda i=i: det(frame(i), conf=0.3) for i in range(3)])
    wait_until(lambda: len(FakeYOLO.batches) == 1 and det._entry.queue.qsize() == 2)
    FakeYOLO.gate.set()
    for t in ts:
        t.join(10)
    assert FakeYOLO.batches == [1, 1, 1]


def test_model_error_reaches_every_request_in_the_batch(make_pool, monkeypatch):
    pool = make_pool(max_batch=3)
    det = pool.acquire("m.onnx", 640)

    def boom(self, source, **kwargs):
        FakeYOLO.batches.append(len(source))
        FakeYOLO.gate.wait(10)
        raise ValueError("boom")

    monkeypatch.setattr(FakeYOLO, "__call__", boom)
    FakeYOLO.gate.clear()
    errors = []

    def call(i):
        try:
            det(frame(i), conf=0.3)
        except ValueError as e:
            errors.append(e)

    first = run_in_threads([lambda: call(0)])
    wait_until(lambda: FakeYOLO.batches == [1])
    rest = run_in_threads([lambda i=i: call(i) for i in (1, 2, 3)])
    wait_until(lambda: det._entry.queue.qsize() == 3)
    FakeYOLO.gate.set()
    for t in first + rest:
        t.join(10)
    assert FakeYOLO.batches == [1, 3] and len(errors) == 4


def test_load_error_keeps_nothing(fake_pool):
    with pytest.raises(FileNotFoundError):
        fake_pool.acquire("missing.onnx", 640)
    assert fake_pool.loaded() == []
    assert FakeYOLO.loads == 0


def test_concurrent_first_acquires_load_once(fake_pool):
    FakeYOLO.load_gate.clear()
    handles = []
    ts = run_in_threads([lambda: handles.append(fake_pool.acquire("m.onnx", 640)) for _ in range(3)])
    wait_until(lambda: sum(e.refs for e in fake_pool._entries.values()) == 3)
    FakeYOLO.load_gate.set()
    for t in ts:
        t.join(10)
    assert FakeYOLO.loads == 1 and len(handles) == 3
    for h in handles:
        fake_pool.release(h)
    assert fake_pool.loaded() == []


def test_call_timeout(make_pool):
    pool = make_pool(call_timeout=0.2)
    det = pool.acquire("m.onnx", 640)
    FakeYOLO.gate.clear()
    with pytest.raises(TimeoutError):
        det(frame(0))


def test_release_to_zero_stops_the_thread_and_later_calls_fail(fake_pool):
    det = fake_pool.acquire("m.onnx", 640)
    thread = det._entry.thread
    fake_pool.release(det)
    assert not thread.is_alive()
    with pytest.raises(RuntimeError):
        det(frame(0))


def test_release_is_idempotent_per_handle(fake_pool):
    a, b = fake_pool.acquire("m.onnx", 640), fake_pool.acquire("m.onnx", 640)
    fake_pool.release(a)
    fake_pool.release(a)
    assert fake_pool.loaded() == [("m.onnx", 640)]
    fake_pool.release(b)
    assert fake_pool.loaded() == []


def test_release_racing_a_blocked_call_never_hangs_the_caller(make_pool):
    pool = make_pool()
    det = pool.acquire("m.onnx", 640)
    thread = det._entry.thread
    FakeYOLO.gate.clear()
    outcome = []

    def call(i):
        try:
            outcome.append(det(frame(i))[0].orig_img[0, 0, 0])
        except RuntimeError as e:
            outcome.append(e)

    first = run_in_threads([lambda: call(0)])
    wait_until(lambda: FakeYOLO.batches == [1])
    queued = run_in_threads([lambda: call(1)])
    wait_until(lambda: det._entry.queue.qsize() == 1)
    releaser = run_in_threads([lambda: pool.release(det)])
    wait_until(lambda: det._entry.stopping)
    FakeYOLO.gate.set()
    for t in first + queued + releaser:
        t.join(10)
        assert not t.is_alive()
    assert len(outcome) == 2
    assert not thread.is_alive()


def test_close_stops_every_thread_and_blocks_acquire(fake_pool):
    a, b = fake_pool.acquire("m.onnx", 640), fake_pool.acquire("n.onnx", 640)
    threads = [a._entry.thread, b._entry.thread]
    fake_pool.close()
    assert fake_pool.loaded() == [] and not any(t.is_alive() for t in threads)
    with pytest.raises(RuntimeError):
        fake_pool.acquire("m.onnx", 640)
    fake_pool.release(a)  # a release after close is harmless
