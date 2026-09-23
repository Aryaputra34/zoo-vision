# Start from NVIDIA's official CUDA 12 runtime image
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Install Python 3.10 and video decoding libraries (FFmpeg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip python3-dev ffmpeg libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (PyTorch, YOLOv11, ByteTrack, PaddleOCR)
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Run the master multi-camera orchestrator
CMD ["python3", "main.py"]
