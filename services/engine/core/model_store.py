"""
Finds model weight files. Weights are not in git: tools/fetch_models.py puts them in the models
folder (default "models/" under the engine root, or $ZOO_MODELS_DIR).
"""

import os
from typing import Optional

MODELS_DIR_ENV = "ZOO_MODELS_DIR"
DEFAULT_MODELS_DIR = "models"


def resolve_model_path(name: str, models_dir: Optional[str] = None) -> str:
    """
    Path to load a model from:
      1. `name` itself if it exists (absolute, or relative to the working directory);
      2. else <models dir>/<file name> if it exists;
      3. else `name` unchanged for .pt files (Ultralytics downloads its official weights by name);
      4. else FileNotFoundError naming the fetch command.
    """
    if os.path.exists(name):
        return name
    models_dir = models_dir or os.environ.get(MODELS_DIR_ENV) or DEFAULT_MODELS_DIR
    candidate = os.path.join(models_dir, os.path.basename(name))
    if os.path.exists(candidate):
        return candidate
    if name.endswith(".pt"):
        return name
    raise FileNotFoundError(
        f"Model '{name}' not found (looked in '{models_dir}'). Run: python tools/fetch_models.py"
    )
