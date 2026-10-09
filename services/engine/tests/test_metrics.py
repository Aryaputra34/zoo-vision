from core.metrics import MinuteMetrics


def _primed():
    out = []
    mm = MinuteMetrics(lambda n, m, v: out.append((n, m, v)))
    mm.sample("occupancy", 2, 120.0)
    mm.sample("occupancy", 4, 150.5)
    return mm, out


def test_mean_per_minute_is_emitted_when_the_minute_ends():
    mm, out = _primed()
    assert out == []
    mm.sample("occupancy", 9, 180.0)
    assert out == [("occupancy", 120_000, 3.0)]


def test_flush_emits_the_open_minute_once():
    mm, out = _primed()
    mm.sample("occupancy", 9, 180.0)
    out.clear()
    mm.flush()
    assert out == [("occupancy", 180_000, 9.0)]
    mm.flush()
    assert out == [("occupancy", 180_000, 9.0)]


def test_names_are_independent():
    out = []
    mm = MinuteMetrics(lambda n, m, v: out.append((n, m, v)))
    mm.sample("b", 4, 60.0)
    mm.sample("a", 1, 61.0)
    mm.sample("a", 3, 62.0)
    mm.flush()
    assert out == [("a", 60_000, 2.0), ("b", 60_000, 4.0)]
