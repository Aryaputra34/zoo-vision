import sys
from pathlib import Path

# tools/*.py are standalone scripts, not a package: make them importable by the tests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
