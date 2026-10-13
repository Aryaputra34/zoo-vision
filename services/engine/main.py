"""
Zoo & Safari Computer Vision engine entrypoint.
The camera loop moves here in Phase 2, Task 13: the engine will read its cameras from the API. Until then
it does not run cameras. `test_video.py` runs one pipeline on a video file.
"""

import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (%(name)s) %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("MainOrchestrator")


def main() -> int:
    logger.error("The engine runs from the API (Phase 2, Task 13); it does not start cameras yet.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
