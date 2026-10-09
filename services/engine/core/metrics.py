"""Per-minute means for numeric status values."""

from collections.abc import Callable


class MinuteMetrics:
    """Keeps one running mean per name for the current UTC minute.

    A sample in a later minute emits that name's earlier minute through `on_minute(name, minute_ms, mean)`.
    """

    def __init__(self, on_minute: Callable[[str, int, float], None]):
        self._on_minute = on_minute
        self._open: dict[str, list] = {}  # name -> [minute_ms, sum, count]

    def sample(self, name: str, value: float, now: float) -> None:
        minute_ms = int(now // 60) * 60_000
        acc = self._open.get(name)
        if acc is not None and acc[0] != minute_ms:
            self._emit(name, acc)
            acc = None
        if acc is None:
            acc = self._open[name] = [minute_ms, 0.0, 0]
        acc[1] += value
        acc[2] += 1

    def flush(self) -> None:
        for name in sorted(self._open):
            self._emit(name, self._open[name])
        self._open.clear()

    def _emit(self, name: str, acc: list) -> None:
        self._on_minute(name, acc[0], acc[1] / acc[2])
