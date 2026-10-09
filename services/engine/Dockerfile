# CUDA runtime base; torch brings its own CUDA 12.6 libraries (pyproject.toml: pytorch-cu126 index)
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Video decoding (FFmpeg) and OpenCV runtime libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# uv installs Python 3.12 and the locked dependencies into /opt/venv
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /uvx /bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_PROJECT_ENVIRONMENT=/opt/venv UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
# The cache mount keeps downloaded wheels (CUDA torch is ~3 GB) across builds and failed attempts
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

# Application source (.dockerignore keeps local configs, weights and videos out)
COPY . .
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1

# Run the master multi-camera orchestrator
CMD ["python", "main.py"]
