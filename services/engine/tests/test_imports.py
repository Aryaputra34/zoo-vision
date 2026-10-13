import importlib
from importlib import metadata
import pytest
from conftest import ENGINE_DIR

SCRIPTS = ["main", "test_video"]
PACKAGES = ["core", "nx_integration"]
USE_CASES = sorted(d.name for d in (ENGINE_DIR / "usecases").iterdir() if (d / "pipeline.py").is_file())
MODULES = (
    SCRIPTS
    + sorted(f"{d}.{p.stem}" for d in PACKAGES for p in (ENGINE_DIR / d).glob("*.py"))
    + ["usecases"]
    + [f"usecases.{u}.pipeline" for u in USE_CASES]
)


@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module):
    importlib.import_module(module)


def test_onnx_runtime_is_a_declared_dependency():
    import onnx, onnxruntime  # noqa: F401


def test_headless_opencv_is_not_installed():
    with pytest.raises(metadata.PackageNotFoundError):
        metadata.version("opencv-python-headless")
