# Installation & Setup Quick Reference

This repository supports three deployment options. For the complete, detailed deployment specification, see **[07_INSTALLATION_GUIDE.md](docs/07_INSTALLATION_GUIDE.md)**.

---

## ⚡ Quick Start (3 Steps)

### 1. Set Up Python Environment

```bash
# Clone and enter directory
cd zoo-vision

# Create and activate virtual environment
python3 -m venv .venv

# On Linux/macOS:
source .venv/bin/activate
# On Windows PowerShell:
.\.venv\Scripts\Activate.ps1

# Upgrade pip & install PyTorch (CUDA 12 recommended for GPU acceleration)
pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# Install project requirements
pip install -r requirements.txt
```

*(On Ubuntu, ensure media libraries are installed: `sudo apt-get install -y ffmpeg libgl1-mesa-glx libglib2.0-0`)*

---

### 2. Configure System & Cameras

```bash
# Copy example configuration templates
cp configs/app_config.yaml.example configs/app_config.yaml
cp configs/cameras.yaml.example configs/cameras.yaml
```

* Edit `configs/app_config.yaml`: Set `device: "cuda:0"` (or `"cpu"`), and configure your Nx Witness / Nx Meta credentials or leave `mock_mode: true` for offline testing.
* Edit `configs/cameras.yaml`: Specify camera RTSP URLs or local `.mp4` test files.

---

### 3. Verify & Run

```bash
# 1. Run offline smoke test (no cameras needed):
python test_synthetic_demo.py

# 2. Test a video file with live preview:
python test_video.py --video sample_data/cars.mp4 --pipeline vehicle_gate --preview

# 3. Launch full master multi-camera service:
python main.py --preview
```

---

## 🐳 Docker Deployment (Production Server)

With Docker and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed on the host:

```bash
# Build and run container with GPU passthrough
docker compose up -d --build

# Monitor live logs
docker compose logs -f zoo-ai-engine
```

---

## 📚 Complete Guides & References

* **[Complete Installation & Deployment Guide](docs/07_INSTALLATION_GUIDE.md)**: Full guide covering bare metal, Docker, native C++ Nx plugin, systemd daemon, and troubleshooting.
* **[Implementation Plan](docs/01_IMPLEMENTATION_PLAN.md)**: Architecture, phased schedule, and use cases.
* **[Hardware Sizing Guide](docs/03_HARDWARE_SPECIFICATIONS.md)**: Compute, VRAM, and BOM specifications.
* **[Model Building & Training Guide](docs/02_MODEL_BUILDING_GUIDE.md)**: YOLOv11 + ByteTrack + Indonesian ANPR.
* **[Universal Model Exporter Guide](docs/05_MODEL_EXPORT_GUIDE.md)**: Export to ONNX, OpenVINO, and TensorRT.
* **[Magnet Nx Plugin Implementation Plan](docs/06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md)**: Native C++ Nx Meta server plugin.
