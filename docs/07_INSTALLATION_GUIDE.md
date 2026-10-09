# Zoo & Safari Computer Vision System — Installation & Deployment Guide
**Production Setup, Docker Containerization, Local Dev Environment & Nx Meta VMS Integration**

This document provides complete, step-by-step instructions for installing, configuring, and operating the **Zoo & Safari Computer Vision System** across development and production environments.

---

## 📋 Table of Contents

1. [Architecture & Deployment Options](#1-architecture--deployment-options)
2. [System Prerequisites & Hardware Sizing](#2-system-prerequisites--hardware-sizing)
3. [Method A: Local Python Environment (Bare Metal / Dev)](#3-method-a-local-python-environment-bare-metal--dev)
   - [Linux (Ubuntu 22.04 LTS)](#step-1a-system-packages-ubuntu-2204-lts)
   - [Windows 10/11](#step-1b-system-packages-windows-1011)
   - [Python Environment & Dependencies (uv)](#step-2-python-environment--dependencies-uv)
   - [GPU Hardware Acceleration (PyTorch + CUDA)](#step-3-gpu-hardware-acceleration-pytorch--cuda)
4. [Method B: Containerized Deployment (Docker & Docker Compose)](#4-method-b-containerized-deployment-docker--docker-compose)
   - [NVIDIA Container Toolkit Setup](#step-1-nvidia-container-toolkit-host-setup)
   - [Docker Compose Deployment](#step-2-deploy-via-docker-compose)
5. [Method C: Native C++ Nx Meta Plugin (`integrations/nx/plugin`)](#5-method-c-native-c-nx-meta-plugin-integrationsnxplugin)
6. [Configuration & Environment Setup](#6-configuration--environment-setup)
   - [Application Configuration (`services/engine/configs/app_config.yaml`)](#61-application-configuration-servicesengineconfigsapp_configyaml)
   - [Camera Stream Configuration (`services/engine/configs/cameras.yaml`)](#62-camera-stream-configuration-servicesengineconfigscamerasyaml)
   - [Pipeline Rules Configuration (`services/engine/configs/rules/`)](#63-pipeline-rules-configuration-servicesengineconfigsrules)
   - [Model Weights & Acceleration Artifacts](#64-model-weights--acceleration-artifacts)
7. [Verification & Smoke Testing](#7-verification--smoke-testing)
   - [Quick Smoke Test (Synthetic Frames)](#71-quick-smoke-test-synthetic-frames)
   - [Interactive ROI Calibration Tool](#72-interactive-roi-calibration-tool)
   - [Standalone Pipeline Video Tester](#73-standalone-pipeline-video-tester)
   - [Full Master Orchestrator Launch](#74-full-master-orchestrator-launch)
8. [Production Linux Systemd Service Setup](#8-production-linux-systemd-service-setup)
9. [Troubleshooting & Frequently Asked Questions](#9-troubleshooting--frequently-asked-questions)

---

## 1. Architecture & Deployment Options

> **Current architecture (2026-10-02, [ADR-008](adr/ADR-008-python-analytics-mediamtx-dashboard-nx-optional.md)):**
> about 12 cameras per site. Nx is optional.
>
> ```
> cameras ──RTSP/TCP──> MediaMTX ──RTSP──> zoo-vision engine (Python AI) ──events + snapshots──> zoo-vision-fe
>                         │ records, 7-day retention     │ :8000 preview / snapshots API          │ login, /live,
>                         └──── :9996 event clips ───────┴────────────────────────────────────────┘ evidence, clips
> ```
>
> Use Method B (Docker Compose, which also starts MediaMTX) in production. The diagram below is the earlier
> Nx-centred design; Method C (the C++ plugin) is frozen and only relevant to sites that already record on Nx.

The Zoo Vision system operates in three deployment topologies depending on your infrastructure requirements:

```mermaid
flowchart TB
    subgraph Cameras ["CCTV Estate (300 Cameras)"]
        Cam1["Gate Cameras (ANPR/Counting)"]
        Cam2["Cashier Cameras (Presence Check)"]
        Cam3["Restaurant Cameras (Headcount)"]
        Cam4["Riding Platform Cameras"]
    end

    subgraph VMS ["Nx Witness / Nx Meta VMS Layer"]
        NxServer["Nx Mediaserver Cluster<br/>(RTSP Proxy & Metadata Hub)"]
    end

    subgraph Deployment ["Zoo Vision Analytics Options"]
        direction TB
        Opt1["<b>Method A: Python Bare-Metal</b><br/>Local Dev / Workstation Service<br/>(PyTorch + OpenCV + supervision)"]
        Opt2["<b>Method B: Docker Container</b><br/>Host-Networked NVIDIA Docker<br/>(deploy/docker-compose.yml)"]
        Opt3["<b>Method C: Native C++ Plugin</b><br/>In-Process Nx Meta Plugin<br/>(libmagnet_analytics_plugin.so)"]
    end

    subgraph Egress ["Dashboards & Alerts"]
        NxClient["Nx Witness Desktop Client<br/>(Live Bounding Boxes & Bookmarks)"]
        WebDash["Web Analytics Dashboard<br/>(zoo-vision-fe :3000)"]
    end

    Cameras -->|RTSP| NxServer
    NxServer -->|RTSP Restream| Opt1
    NxServer -->|RTSP Restream| Opt2
    NxServer <-->|Zero-Copy YUV420 & Events| Opt3

    Opt1 -->|REST API v3 Bookmarks| NxServer
    Opt2 -->|REST API v3 Bookmarks| NxServer
    Opt1 -->|HTTP POST /api/events| WebDash
    Opt2 -->|HTTP POST /api/events| WebDash
    NxServer --> NxClient
```

| Deployment Mode | Best For | Prerequisites | Pros |
| :--- | :--- | :--- | :--- |
| **Method A: Python Virtualenv** | Local development, debugging, video replay testing | Python 3.10/3.11, CUDA 12.x | Direct access to OpenCV GUI previews, fast code iteration |
| **Method B: Docker Compose** *(Recommended Production)* | 24/7 dedicated AI server, multi-camera headless deployment | Docker Engine, NVIDIA Container Toolkit | Isolated dependencies, auto-restart, identical across environments |
| **Method C: Native C++ Plugin** *(optional, frozen; see ADR-008)* | Sites that already record on Nx and want boxes in Nx Desktop | CMake, G++, Nx Meta Plugin SDK | Zero-copy YUV ingestion, native Nx desktop overlays; no rules, events or dashboard feed |

---

## 2. System Prerequisites & Hardware Sizing

### Minimum & Recommended Hardware

For detailed compute sizing and Bill of Materials, refer to [03_HARDWARE_SPECIFICATIONS.md](03_HARDWARE_SPECIFICATIONS.md).

| Component | Minimum Specification (1–3 Streams / Dev) | Recommended Specification (5–10 Streams / Production) |
| :--- | :--- | :--- |
| **Operating System** | Ubuntu 22.04 LTS or Windows 10/11 (64-bit) | **Ubuntu Server 22.04 LTS** (Clean install) |
| **Processor (CPU)** | Intel Core i5 / AMD Ryzen 5 (4+ Cores) | **Intel Core i7-14700** or **AMD Ryzen 7 7700X** (8+ Cores) |
| **System RAM** | 16 GB DDR4 | **32 GB DDR5** (Dual-Channel) |
| **Graphics Card (GPU)** | NVIDIA GTX 1660 / RTX 3050 (6GB VRAM) or CPU | **NVIDIA RTX 4070 (12GB)** or **RTX 3060 (12GB)** |
| **Storage** | 50 GB free disk space (SSD) | **500 GB NVMe PCIe 4.0 SSD** |
| **Network** | 100 Mbps Ethernet | **1 Gbps (Gigabit Ethernet) RJ-45** |

### Software Prerequisites

* **NVIDIA GPU Driver**: Version **>= 535.xx** (supports CUDA 12.x)
* **Python**: Version **3.10** or **3.11** (Python 3.12+ may have package wheel incompatibilities with certain deep learning libraries)
* **FFmpeg**: System video decoding libraries (`ffmpeg`, `libgl1`, `libglib2.0-0`)
* **Git**: Version >= 2.30

---

## 3. Method A: Local Python Environment (Bare Metal / Dev)

### Step 1A: System Packages (Ubuntu 22.04 LTS)

Install system-level build tools and media codecs:

```bash
# Update package lists
sudo apt-get update && sudo apt-get upgrade -y

# Install Python 3.11, pip, venv, and essential multimedia libraries
sudo apt-get install -y \
    python3-pip \
    python3-dev \
    python3-venv \
    ffmpeg \
    libgl1-mesa-glx \
    libglib2.0-0 \
    build-essential \
    curl \
    git
```

### Step 1B: System Packages (Windows 10/11)

1. **Python**: Download and install [Python 3.11.x](https://www.python.org/downloads/) from python.org.
   * ⚠️ **Important**: Check the box **"Add python.exe to PATH"** during setup.
2. **Git**: Install [Git for Windows](https://git-scm.com/download/win).
3. **FFmpeg** (Optional but recommended):
   ```powershell
   winget install Gyan.FFmpeg
   ```
4. **NVIDIA Driver**: Install the latest Game Ready or Studio Driver from [nvidia.com/drivers](https://www.nvidia.com/download/index.aspx).

---

### Step 2: Python Environment & Dependencies (uv)

The engine is a [uv](https://docs.astral.sh/uv/) project in `services/engine/`. uv installs Python 3.12 and the exact
locked dependencies (`uv.lock`), so there are no manual venv or pip steps.

```bash
# 1. Install uv and git-lfs
#    Linux:   curl -LsSf https://astral.sh/uv/install.sh | sh   and   sudo apt install git-lfs
#    Windows: winget install astral-sh.uv   and   winget install GitHub.GitLFS

# 2. Enter the engine folder of the cloned repository
cd ~/zoo-vision/services/engine   # On Windows: cd C:\Users\<YourUser>\Documents\WORK\zoo-vision\services\engine

# 3. Create .venv with the locked dependencies
uv sync

# 4. Fetch the model weights (not stored in git) into services/engine/models/
python ../../tools/fetch_models.py
```

Every engine command below runs from `services/engine/` through `uv run` (for example `uv run python main.py`).

---

### Step 3: GPU Hardware Acceleration (PyTorch + CUDA)

`services/engine/pyproject.toml` already chooses the PyTorch build:
* **Linux**: CUDA 12.6 wheels from the PyTorch index. Needs NVIDIA driver 525.60 or newer (560+ recommended).
* **Windows**: CPU wheels from PyPI (development).

Verify GPU visibility:

```bash
uv run python -c "import torch; print(f'CUDA Available: {torch.cuda.is_available()} | GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"None\"}')"
```

*Expected output on the GPU server: `CUDA Available: True | GPU: NVIDIA GeForce RTX ...`*

---

### Step 4: What `uv sync` Installs

`services/engine/pyproject.toml` lists the dependencies and `uv.lock` pins every version:
* `ultralytics` (YOLO engine, PyTorch inference, video frame decoders)
* `supervision` (ByteTrack tracker, LineZone tripwires, PolygonZone ROIs); kept below 0.31, which removes `sv.ByteTrack`
* `shapely` (Planar geometry for polygon intersection math)
* `easyocr` (Deep learning OCR for Indonesian license plate recognition)
* `requests` (Nx Meta REST API v3 HTTP client), `fastapi` + `uvicorn` (engine API for the dashboard)
* `pydantic`, `pyyaml`, `python-dotenv`, `tqdm` (Configuration and schema validation)
* `torch`, `torchvision`, `onnx` and ONNX Runtime (`onnxruntime` on Windows, `onnxruntime-gpu` on Linux)

#### Optional Export Runtimes:

Only needed to export models to these formats with `tools/export_model.py`; they are not in the lock, and the next
`uv sync` removes them again:

```bash
uv pip install "openvino>=2024.0.0"   # Intel OpenVINO (Intel Core CPUs and integrated Iris/UHD graphics)
uv pip install tensorrt               # NVIDIA TensorRT (low-latency FP16 engine on RTX GPUs)
```

---

## 4. Method B: Containerized Deployment (Docker & Docker Compose)

Docker is the recommended deployment method for production Linux servers. It encapsulates CUDA runtimes, FFmpeg, and Python packages, eliminating dependency drift.

### Step 1: NVIDIA Container Toolkit Host Setup

On the host Ubuntu 22.04 LTS server:

```bash
# 1. Install Docker Engine
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# 2. Configure the NVIDIA Container Toolkit repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# 3. Install NVIDIA Container Toolkit
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# 4. Configure Docker daemon for NVIDIA runtime
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 5. Verify GPU passthrough into Docker
docker run --rm --gpus all nvidia/cuda:12.4.1-runtime-ubuntu22.04 nvidia-smi
```

*If `nvidia-smi` displays your GPU inside the container, Docker is ready.*

---

### Step 2: Deploy via Docker Compose

The repository includes a ready-to-use [`services/engine/Dockerfile`](../services/engine/Dockerfile) and [`deploy/docker-compose.yml`](../deploy/docker-compose.yml).

```bash
# 1. Navigate to the deploy folder
cd ~/zoo-vision/deploy

# 2. Prepare configuration (see Section 6) and model weights
cp .env.example .env              # ZOO_DATA_DIR (default ./data) and ZOO_VERSION
cp ../services/engine/configs/app_config.yaml.example ../services/engine/configs/app_config.yaml
cp ../services/engine/configs/cameras.yaml.example ../services/engine/configs/cameras.yaml
#    and list every camera's RTSP URL under `paths:` in deploy/mediamtx.yml
python3 ../tools/fetch_models.py --dest ./data/models    # offline site: add --from /media/usb/models

# 3. Build and start the containers (MediaMTX + AI engine) in detached mode
docker compose up -d --build

# 4. Inspect container health and live inference logs
docker compose logs -f zoo-ai-engine
docker compose logs -f mediamtx      # "[path cam_...] [RTSP source] ready" per camera
```

#### Cameras, MediaMTX and the dashboard

1. In `deploy/mediamtx.yml`, add one path per camera:
   `cam_cashier_01: {source: rtsp://user:pass@<camera>/stream1}`. Set the cameras to H.264 so browsers can
   play the clips.
2. In `services/engine/configs/cameras.yaml`, read each camera from MediaMTX and name its recording:
   `source: rtsp://127.0.0.1:8554/cam_cashier_01` and `recording_path: cam_cashier_01`.
3. In `services/engine/configs/app_config.yaml`:
   * `api_server.host`: set to `0.0.0.0` if the dashboard runs on another host.
   * `api_server.api_key`: set a long random key.
   * `snapshots.retention_days`: how many days of event snapshots to keep.
4. In the dashboard's `.env.local`:
   * `AI_ENGINE_URL=http://<ai-host>:8000`
   * `AI_ENGINE_API_KEY=<same key>`
   * `MEDIAMTX_PLAYBACK_URL=http://<ai-host>:9996`
   * `DASHBOARD_PASSWORD=<shared login>`
5. Keep ports 8000 (AI API) and 8554/8889/9996 (MediaMTX) on the internal network. MediaMTX only allows
   reads and playback from private address ranges.
6. Disk: recordings take ~43 GB/day per 4 Mbit/s camera. Tune `recordDeleteAfter` in `deploy/mediamtx.yml`.
7. Run NTP on the AI server and the cameras, so event times line up with the recorded clips.

#### Key Elements of `deploy/docker-compose.yml`:
* `mediamtx` service: pulls every camera once, records to `${ZOO_DATA_DIR}/recordings`, re-serves RTSP on `:8554` and event clips on `:9996`.
* `network_mode: "host"`: Guarantees the lowest latency for RTSP stream ingestion and REST calls without Docker NAT overhead.
* `capabilities: [ gpu, video ]`: Exposes both CUDA Tensor cores and NVDEC hardware video decoding ASICs to the container.
* Volume Mounts:
  * `../services/engine/configs:/app/configs`: Modify camera streams, polygons, and thresholds on the fly without restarting or rebuilding the image.
  * `${ZOO_DATA_DIR}/models:/app/models`: Model weights fetched by `tools/fetch_models.py`; hot-swap TensorRT `.engine` or ONNX files.
  * `${ZOO_DATA_DIR}/logs:/app/logs`: Persist operational logs directly on host storage.
  * `${ZOO_DATA_DIR}/snapshots:/app/snapshots`: Event JPEGs, served to the dashboard by the AI engine API.

#### Common Container Management Commands:

```bash
# From deploy/:
# Stop service
docker compose stop

# Restart service after editing services/engine/configs/cameras.yaml
docker compose restart

# Tear down container
docker compose down

# Check resource consumption (GPU memory, CPU, RAM)
docker stats zoo_vision_service
```

---

## 5. Method C: Native C++ Nx Meta Plugin (`integrations/nx/plugin`)

> **Optional and frozen** ([ADR-008](adr/ADR-008-python-analytics-mediamtx-dashboard-nx-optional.md)). Only for sites
> that already record these cameras on Nx. The plugin draws boxes in Nx Desktop, but has no rules, no events and no
> dashboard feed. Methods A/B remain required for analytics.

For deployments requiring in-process execution inside Network Optix MetaVMS Server (`metavms-server` / `nxwitness-server`), deploy the native C++ plugin.

```bash
# 1. Transfer the integrations/nx/plugin directory (arrives as ~/plugin) and the Nx Meta Plugin SDK to your Linux server
scp -r integrations/nx/plugin/ user@<server-ip>:~/

# 2. Connect to the server
ssh user@<server-ip>
cd ~/plugin

# 3. Execute the automated build script
chmod +x build_on_server.sh
./build_on_server.sh
```

The script will automatically:
1. Validate required build packages (`cmake`, `g++`, `make`, `wget`, `unzip`).
2. Download and unpack **ONNX Runtime C++ Linux x64 (v1.18.0)** into `/opt/onnxruntime`.
3. Extract the Nx Meta Plugin SDK headers.
4. Compile `libmagnet_analytics_plugin.so`.
5. Install the library into the Nx Mediaserver plugins directory:
   `/opt/networkoptix/mediaserver/bin/plugins/` (or `/opt/networkoptix-metavms/mediaserver/bin/plugins/`).
6. Restart the Nx Mediaserver service:
   ```bash
   sudo systemctl restart metavms-mediaserver
   # Or for standard Nx Witness:
   sudo systemctl restart networkoptix-mediaserver
   ```

In **Nx Desktop Client**:
* Open **Camera Settings** $\to$ **Plugins** tab.
* Toggle **"Magnet AI Vision Analytics"** to **ON**.

For complete details, see [06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md](06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md).

---

## 6. Configuration & Environment Setup

Before starting the service, initialize your local configuration files from the provided `.example` templates.

```bash
# From services/engine/: copy the example configuration templates (the copies are git-ignored)
cp configs/app_config.yaml.example configs/app_config.yaml
cp configs/cameras.yaml.example configs/cameras.yaml
```

### 6.1 Application Configuration (`services/engine/configs/app_config.yaml`)

Open `services/engine/configs/app_config.yaml` in your editor and configure your environment:

```yaml
# Nx Witness / Nx Meta Media Server Connection Settings
nx_server:
  host: "127.0.0.1"             # IP of Nx Media Server (e.g., 192.168.1.100)
  port: 7001                    # Default Nx Server port
  use_https: true
  verify_ssl: false             # Set to false for self-signed certificates in lab
  auth:
    username: "admin"
    password: "YOUR_PASSWORD_HERE" # Your Nx server credentials
    token: ""                   # Optional bearer token (auto-negotiated if empty)
  mock_mode: true               # Set to 'false' in production with live Nx Server!
                                # When 'true', bookmarks and events are logged locally without network errors.

# Logging & Storage Settings
logging:
  level: "INFO"                 # DEBUG, INFO, WARNING, ERROR
  log_to_file: true
  log_file_path: "logs/zoo_ai.log"

# Global AI Settings
ai_engine:
  device: "cuda:0"              # "cuda:0" for NVIDIA GPU; "cpu" for local development
  model_cache_dir: "models"
  default_confidence: 0.35

# Web Analytics Dashboard Integration (zoo-vision-fe)
analytics:
  enabled: true                 # Set to false if dashboard is not deployed
  api_url: "http://localhost:3000/api/events"
  api_key: ""                   # INGEST_API_KEY from dashboard .env.local (empty = no auth)
```

---

### 6.2 Camera Stream Configuration (`services/engine/configs/cameras.yaml`)

Define your RTSP video sources, target FPS, and pipeline bindings in `services/engine/configs/cameras.yaml` (`rule_config` paths are relative to `services/engine/`):

```yaml
cameras:
  # Use Case 2: Cashier Presence & Service SLA
  - id: "cam_cashier_01"
    name: "Ticket Booth 1 Cashier"
    nx_camera_id: "00000000-0000-0000-0000-000000000001" # Nx Camera UUID (from Nx Desktop)
    source: "rtsp://admin:password@192.168.1.50:554/live" # Or local MP4: "sample_data/kasir.mp4"
    pipeline: "cashier_presence"
    target_fps: 5                                          # 5 FPS is optimal for desk monitoring
    enabled: true
    rule_config: "configs/rules/cashier_presence.yaml"
    roi:
      clerk_zone:
        - [0.33, 0.46]
        - [0.72, 0.46]
        - [0.72, 1.00]
        - [0.33, 1.00]
      visitor_zone:
        - [0.36, 0.12]
        - [0.64, 0.12]
        - [0.64, 0.46]
        - [0.36, 0.46]

  # Use Case 3: Restaurant Occupancy & Headcount
  - id: "cam_restaurant_01"
    name: "Safari Cafe Dining Hall"
    nx_camera_id: "00000000-0000-0000-0000-000000000002"
    source: "rtsp://admin:password@192.168.1.52:554/live"
    pipeline: "restaurant_counter"
    target_fps: 2
    enabled: true
    rule_config: "configs/rules/restaurant_counter.yaml"

  # Use Case 1: Vehicle Gate Entry & LPR
  - id: "cam_gate_entry_01"
    name: "Main Vehicle Gate 1"
    nx_camera_id: "00000000-0000-0000-0000-000000000003"
    source: "rtsp://admin:password@192.168.1.53:554/live"
    pipeline: "vehicle_gate"
    target_fps: 12
    enabled: true
    rule_config: "configs/rules/vehicle_gate.yaml"

  # Use Case 4: Horse-Riding Revenue Audit
  - id: "cam_horse_riding_01"
    name: "Pony Riding Platform Departure"
    nx_camera_id: "00000000-0000-0000-0000-000000000004"
    source: "rtsp://admin:password@192.168.1.54:554/live"
    pipeline: "horse_riding"
    target_fps: 8
    enabled: false
    rule_config: "configs/rules/horse_riding.yaml"
```

> [!NOTE]
> Coordinates are normalized between `[0.0, 1.0]` across width and height, making calibration resolution-independent (whether the camera streams in 720p, 1080p, or 4K).

---

### 6.3 Pipeline Rules Configuration (`services/engine/configs/rules/`)

Each pipeline has a dedicated rule file defining operational thresholds:
* `services/engine/configs/rules/cashier_presence.yaml`: Absence warning threshold (`absence_warning_sec: 180`), critical absence threshold (`absence_critical_sec: 300`), queue wait alerts.
* `services/engine/configs/rules/restaurant_counter.yaml`: Headcount capacity alert limits, dwell time thresholds, bidirectional tripwire lines.
* `services/engine/configs/rules/vehicle_gate.yaml`: Directional entry/exit lines, vehicle class whitelist, ANPR crop confidence.
* `services/engine/configs/rules/horse_riding.yaml`: Choke-point line crossings, handler rejection filters, tripwire debounce intervals.

---

### 6.4 Model Weights & Acceleration Artifacts

The system automatically loads models configured per pipeline. By default:
* Model weights are not stored in git. `python tools/fetch_models.py` downloads the files listed in [`services/engine/models/manifest.json`](../services/engine/models/manifest.json) into `services/engine/models/` and checks their sha256; `--from <folder>` copies them on offline sites (see [tools/README.md](../tools/README.md)).
* Ultralytics still downloads its official `.pt` weights by name if one is missing.

#### Exporting Custom Weights to High-Performance Formats:
Use the included Universal Model Exporter CLI to generate hardware-optimized models:

```bash
# From the repo root. Interactive export wizard:
uv run --project services/engine python tools/export_model.py

# Or direct 1-click export to 16:9 widescreen ONNX:
uv run --project services/engine python tools/export_model.py --model services/engine/models/yolo11s.pt --format onnx --imgsz 736 1280 --dynamic

# Or export to NVIDIA TensorRT (FP16):
uv run --project services/engine python tools/export_model.py --model services/engine/models/yolo11s.pt --format engine --imgsz 640 --half
```

For complete export syntax and benchmarks, consult [05_MODEL_EXPORT_GUIDE.md](05_MODEL_EXPORT_GUIDE.md).

---

## 7. Verification & Smoke Testing

### 7.1 Quick Smoke Test (Synthetic Frames)

Verify that the Python environment, PyTorch, ByteTrack, Shapely, and all pipeline logic operate without errors—no camera streams or video files needed:

```bash
# From services/engine/:
uv run pytest                        # automated tests (no models or GPU needed)
uv run python test_synthetic_demo.py  # synthetic-frame smoke test with real models
```

*Expected output:*
```text
=== STARTING PHASE 1 SMOKE TEST ===
--- Testing Cashier Presence Pipeline ---
✅ Cashier Presence pipeline processed frame successfully.
--- Testing Restaurant Counter Pipeline ---
✅ Restaurant Counter pipeline processed frame successfully.
--- Testing Vehicle Gate Pipeline ---
✅ Vehicle Gate pipeline processed frame successfully.
=== ALL PHASE 1 PIPELINE TESTS PASSED! ===
```

---

### 7.2 Interactive ROI Calibration Tool

Use [`tools/pick_coordinates.py`](../tools/pick_coordinates.py) to visually calibrate tripwires or polygon zones on any camera video feed or sample recording:

```bash
# From the repo root. Calibrate a LineZone tripwire:
uv run --project services/engine python tools/pick_coordinates.py --video services/engine/sample_data/cars.mp4 --mode line

# Calibrate a PolygonZone area (e.g. Cashier desk or Dining area):
uv run --project services/engine python tools/pick_coordinates.py --video services/engine/sample_data/cars.mp4 --mode polygon
```

* **Controls**:
  * **Left Click**: Place coordinate point.
  * **Right Click**: Undo last point.
  * **Spacebar**: Pause / Resume video playback.
  * **C**: Clear all points.
  * **Q / Esc**: Exit and print ready-to-paste YAML coordinates to your console.

---

### 7.3 Standalone Pipeline Video Tester

Test and preview any pipeline on a local `.mp4` file before connecting live camera streams:

```bash
# From services/engine/. Test Vehicle Gate & ANPR pipeline with interactive GUI and Web Dashboard sync:
uv run python test_video.py --video sample_data/cars.mp4 --pipeline gate --analytics

# Save an annotated demonstration video for review:
uv run python test_video.py --video sample_data/cars.mp4 --pipeline gate --save-output demo_gate.mp4
```

> [!TIP]
> For a full command matrix across all 5 use cases and web dashboard testing steps, refer to **[docs/08_TESTING_GUIDE.md](08_TESTING_GUIDE.md)**.

---

### 7.4 Full Master Orchestrator Launch

Run the multi-camera master orchestrator:

```bash
# From services/engine/. Headless production execution:
uv run python main.py

# With live OpenCV desktop preview windows:
uv run python main.py --preview

# Using custom configuration files:
uv run python main.py --app-config configs/app_config.yaml --cameras-config configs/cameras.yaml
```

---

## 8. Production Linux Systemd Service Setup

To ensure 24/7 continuous operation on bare-metal Ubuntu servers with automatic restarts on crash or reboot:

### 1. Create the Systemd Unit File

```bash
sudo nano /etc/systemd/system/zoo-vision.service
```

Paste the following configuration (replace `/home/administrator/zoo-vision` with your actual workspace path and user):

```ini
[Unit]
Description=Zoo & Safari Computer Vision Analytics Orchestrator
After=network.target metavms-mediaserver.service
Wants=network-online.target

[Service]
Type=simple
User=administrator
Group=administrator
WorkingDirectory=/home/administrator/zoo-vision/services/engine
Environment="PATH=/home/administrator/zoo-vision/services/engine/.venv/bin:/usr/local/cuda/bin:/usr/bin"
Environment="PYTHONUNBUFFERED=1"
Environment="CUDA_VISIBLE_DEVICES=0"
ExecStart=/home/administrator/zoo-vision/services/engine/.venv/bin/python main.py
Restart=always
RestartSec=5s
KillSignal=SIGINT
TimeoutStopSec=15s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

### 2. Enable and Start the Service

```bash
# Reload systemd daemon
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable zoo-vision.service

# Start the service
sudo systemctl start zoo-vision.service

# Check service status
sudo systemctl status zoo-vision.service

# Stream live real-time logs
journalctl -u zoo-vision.service -f
```

---

## 9. Troubleshooting & Frequently Asked Questions

### Q1: `CUDA out of memory (OOM)` during multi-camera inference
* **Cause**: Aggregate VRAM allocated to YOLO, ByteTrack, NVDEC buffers, and OCR exceeded your GPU capacity.
* **Resolution**:
  1. In `services/engine/configs/cameras.yaml`, lower camera `target_fps` (e.g., reduce Cashier monitoring from 5 to 2 FPS, Restaurant from 5 to 2 FPS).
  2. Use smaller model architectures (switch from `yolo11m` to `yolo11s` or `yolo11n`).
  3. Export models to **FP16 Half-Precision** via `uv run --project services/engine python tools/export_model.py --model services/engine/models/yolo11s.pt --half --format engine`.
  4. Refer to the VRAM budget breakdown in [03_HARDWARE_SPECIFICATIONS.md](03_HARDWARE_SPECIFICATIONS.md).

---

### Q2: `ImportError: libGL.so.1: cannot open shared object file: No such file or directory`
* **Cause**: Missing Linux system OpenGL libraries required by OpenCV.
* **Resolution**:
  ```bash
  sudo apt-get install -y libgl1-mesa-glx libglib2.0-0
  ```
  *(Or if running headless without GUI display, replace `opencv-python` with `opencv-python-headless`).*

---

### Q3: `Failed to open RTSP stream: rtsp://...` or high stream latency
* **Cause**: Network firewall, saturated camera encoder, or wrong RTSP credentials.
* **Resolution**:
  1. Verify the RTSP stream in VLC Media Player (`Media -> Open Network Stream`).
  2. In production, configure cameras to stream directly into the Nx Media Server first, then ingest the **Nx-proxied RTSP restream**:
     `rtsp://admin:pass@<nx-server-ip>:7001/media/<nx_camera_id>`
     *(This shields IP camera hardware encoders from multiple stream requests).*

---

### Q4: `NxClient: 401 Unauthorized` or SSL Certificate Errors
* **Cause**: Incorrect username/password in `services/engine/configs/app_config.yaml` or untrusted self-signed SSL certificate.
* **Resolution**:
  1. Verify credentials in `services/engine/configs/app_config.yaml` under `nx_server.auth`.
  2. In test environments with self-signed SSL, ensure `verify_ssl: false` is set.
  3. Set `mock_mode: true` to bypass Nx network authentication completely during offline development.

---

### Q5: EasyOCR model download hangs on first run
* **Cause**: First-time initialization downloads pre-trained language weights from GitHub/PyTorch hub.
* **Resolution**:
  Ensure outgoing internet access on the server during the initial test run (`uv run python test_synthetic_demo.py` in `services/engine/`). Once downloaded, weights are cached locally in `~/.EasyOCR/model/` and work 100% offline.

---

### Q6: Path separator errors on Windows vs Linux
* **Cause**: Backslashes (`\`) vs Forward slashes (`/`) in YAML configuration files.
* **Resolution**:
  Always use forward slashes (`/`) in `services/engine/configs/app_config.yaml` and `services/engine/configs/cameras.yaml` (e.g. `sample_data/cars.mp4`). Python's `os.path` handles forward slashes transparently on both Windows and Linux.
