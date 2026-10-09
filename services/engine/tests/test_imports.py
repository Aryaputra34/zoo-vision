import importlib
from importlib import metadata
import pytest
from conftest import ENGINE_DIR

SCRIPTS = ["main", "test_video", "simulate_demo", "test_synthetic_demo"]
PACKAGES = ["core", "pipelines", "nx_integration"]
MODULES = SCRIPTS + sorted(f"{d}.{p.stem}" for d in PACKAGES for p in (ENGINE_DIR / d).glob("*.py"))


@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module):
    importlib.import_module(module)


def test_onnx_runtime_is_a_declared_dependency():
    import onnx, onnxruntime  # noqa: F401


def test_headless_opencv_is_not_installed():
    with pytest.raises(metadata.PackageNotFoundError):
        metadata.version("opencv-python-headless")
