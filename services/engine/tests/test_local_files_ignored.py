import subprocess
import pytest
from conftest import ENGINE_DIR


@pytest.mark.parametrize("path", ["configs/cameras.yaml", "configs/app_config.yaml", ".env"])
def test_local_operator_files_are_git_ignored(path):
    assert subprocess.run(["git", "check-ignore", "-q", path], cwd=ENGINE_DIR).returncode == 0


def test_dockerignore_keeps_local_files_out_of_image():
    lines = [line.strip() for line in (ENGINE_DIR / ".dockerignore").read_text().splitlines()]
    assert {".env", "models/", ".venv/"} <= set(lines)
    # every local config file (cameras.yaml, cameras.yaml.bak, site copies...) stays out; examples and rules go in
    assert lines.index("configs/*") < lines.index("!configs/*.example")
    assert lines.index("configs/*") < lines.index("!configs/rules")
