"""
Event Snapshot Store.
Saves one annotated JPEG per dashboard event; core/api_server.py serves them at /snapshots/<path>.
Layout: <root>/<camera_id>/<YYYY-MM-DD>/<event_id>.jpg (server-local date). A background thread
deletes day folders older than retention_days.
"""

import re
import time
import shutil
import logging
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger("SnapshotStore")

PRUNE_INTERVAL_SEC = 3600
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")  # no dots: an id of ".." must not climb out of root
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


class SnapshotStore:
    def __init__(self, root: str = "snapshots", retention_days: int = 30, jpeg_quality: int = 80, max_width: int = 1920):
        self.root = Path(root).resolve()
        self.retention_days = retention_days
        self.jpeg_quality = jpeg_quality
        self.max_width = max_width
        self.root.mkdir(parents=True, exist_ok=True)

        self._stop = threading.Event()
        if retention_days > 0:
            threading.Thread(target=self._prune_loop, daemon=True, name="SnapshotPruner").start()
        logger.info(f"Event snapshots -> {self.root} (retention: {retention_days or 'forever'} days)")

    def save(self, camera_id: str, event_id: str, frame: np.ndarray) -> Optional[str]:
        """Writes the frame as JPEG; returns its path relative to root, or None on failure."""
        rel = f"{_UNSAFE.sub('_', camera_id)}/{time.strftime('%Y-%m-%d')}/{_UNSAFE.sub('_', event_id)}.jpg"
        try:
            h, w = frame.shape[:2]
            if w > self.max_width:
                frame = cv2.resize(frame, (self.max_width, int(h * self.max_width / w)), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
            if not ok:
                return None
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(buf.tobytes())
            return rel
        except Exception as e:  # a full disk must not take the pipeline down
            logger.warning(f"[{camera_id}] Could not save snapshot {rel}: {e}")
            return None

    def resolve(self, rel: str) -> Optional[Path]:
        """Maps a relative snapshot path to a file inside root; None for anything else (no ../ escapes)."""
        path = (self.root / rel).resolve()
        if path.suffix == ".jpg" and path.is_relative_to(self.root) and path.is_file():
            return path
        return None

    def prune(self):
        cutoff = (date.today() - timedelta(days=self.retention_days)).isoformat()
        for cam_dir in self.root.iterdir():
            if not cam_dir.is_dir():
                continue
            for day_dir in cam_dir.iterdir():
                if day_dir.is_dir() and _DAY.fullmatch(day_dir.name) and day_dir.name < cutoff:
                    shutil.rmtree(day_dir, ignore_errors=True)
                    logger.info(f"Pruned snapshots {cam_dir.name}/{day_dir.name}")

    def _prune_loop(self):
        while True:
            try:
                self.prune()
            except Exception as e:
                logger.warning(f"Snapshot prune failed: {e}")
            if self._stop.wait(PRUNE_INTERVAL_SEC):
                return

    def stop(self):
        self._stop.set()


if __name__ == "__main__":
    # Self-check: python -m core.snapshot_store
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = SnapshotStore(tmp, retention_days=0)
        rel = store.save("cam/../01", "evt_abc", np.zeros((1080, 3840, 3), np.uint8))
        assert rel and rel.startswith("cam____01/"), rel
        assert store.resolve(rel) is not None
        assert cv2.imread(str(store.resolve(rel))).shape[1] == 1920
        assert store.resolve("../" + rel) is None and store.resolve("cam____01") is None
        assert store.save("..", "..", np.zeros((4, 4, 3), np.uint8)).startswith("__/")

        old = Path(tmp, "cam_x", "2000-01-01")
        old.mkdir(parents=True)
        store.retention_days = 30
        store.prune()
        assert not old.exists() and store.resolve(rel) is not None
    print("ok")
