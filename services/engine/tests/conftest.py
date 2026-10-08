from pathlib import Path
import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def engine_cwd(monkeypatch):
    """Rule and model paths in configs are relative to the engine root."""
    monkeypatch.chdir(ENGINE_DIR)
