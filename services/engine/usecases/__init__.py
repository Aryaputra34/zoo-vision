"""Use case registry. Each subpackage `usecases/<name>/` holds `pipeline.py` with one BasePipeline subclass
whose `use_case` is the contract use case id. Camera workers build pipelines through `create_pipeline`.
"""

import importlib
import inspect
import pkgutil
from functools import cache
from typing import Iterable

from pydantic import BaseModel

from core.base_pipeline import BasePipeline, CameraInfo
from core.model_pool import Detector


def _index(classes: Iterable[type[BasePipeline]]) -> dict[str, type[BasePipeline]]:
    found: dict[str, type[BasePipeline]] = {}
    for cls in classes:
        if cls.use_case in found:
            raise ValueError(
                f"Two pipelines for use case '{cls.use_case}': "
                f"{found[cls.use_case].__qualname__} and {cls.__qualname__}"
            )
        found[cls.use_case] = cls
    return found


@cache
def _registry() -> dict[str, type[BasePipeline]]:
    classes = []
    for info in pkgutil.iter_modules(__path__):
        if not info.ispkg:
            continue
        module = importlib.import_module(f"{__name__}.{info.name}.pipeline")
        classes += [
            cls for _, cls in inspect.getmembers(module, inspect.isclass)
            if issubclass(cls, BasePipeline) and cls.__module__ == module.__name__
        ]
    return _index(classes)


def pipeline_class(use_case: str) -> type[BasePipeline]:
    """The pipeline class of a use case. KeyError for an unknown use case."""
    return _registry()[use_case]


def use_cases() -> list[str]:
    return sorted(_registry())


def create_pipeline(
    camera: CameraInfo, use_case: str, settings: BaseModel, model: Detector, **kwargs
) -> BasePipeline:
    return pipeline_class(use_case)(camera, settings, model, **kwargs)
