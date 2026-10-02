# MediaMTX Setup & Testing Guide

This guide explains how to install, configure, and test **MediaMTX** (formerly `rtsp-simple-server`) as the video streaming and recording backbone for the **Zoo & Safari AI Vision System**.

As defined in **[ADR-008](adr/ADR-008-python-analytics-mediamtx-dashboard-nx-optional.md)**, MediaMTX provides a lightweight, zero-license alternative to traditional VMS solutions.

---

## 📋 Table of Contents
1. [MediaMTX Role & Architecture](#1-mediamtx-role--architecture)
2. [Port Allocation & Network Map](#2-port-allocation--network-map)
3. [Installation Methods (Windows & Docker)](#3-installation-methods-windows--docker)
4. [Configuration (`configs/mediamtx.yml`) Explained](#4-configuration-configsmediamtxyml-explained)
5. [Step-by-Step Testing & Verification](#5-step-by-step-testing--verification)
   * [Step 1: Start MediaMTX](#step-1-start-mediamtx)
   * [Step 2: Publish Simulated Camera Feeds with FFmpeg](#step-2-publish-simulated-camera-feeds-with-ffmpeg)
   * [Step 3: Verify RTSP Ingestion & Playback](#step-3-verify-rtsp-ingestion--playback)
   * [Step 4: Verify Disk Recording](#step-4-verify-disk-recording)
   * [Step 5: Test HTTP Clip Playback API (`:9996`)](#step-5-test-http-clip-playback-api-9996)
6. [End-to-End Integration with Web Dashboard & AI Engine](#6-end-to-end-integration-with-web-dashboard--ai-engine)
7. [Troubleshooting & FAQ](#7-troubleshooting--faq)

---

## 1. MediaMTX Role & Architecture

```mermaid
graph TD
    subgraph Cameras ["Physical IP Cameras / FFmpeg Simulators"]
        Cam1["RTSP IP Camera 1<br/>192.168.1.50:554"]
        Cam2["RTSP IP Camera 2<br/>192.168.1.52:554"]
        Sim["FFmpeg Video Loop<br/>(Testing Mode)"]
    end

    subgraph MediaMTX ["MediaMTX Video Backbone (:8554, :9996)"]
        Puller["RTSP Ingest / Puller (TCP)"]
        Recorder["24/7 Rolling Segment Recorder<br/>./recordings/%path/%Y-%m-%d..."]
        RTSPReServer["Local RTSP Re-Server<br/>rtsp://127.0.0.1:8554/<path>"]
        PlaybackAPI["HTTP Playback Server (:9996)<br/>GET /get?path=<id>&start=<iso>&duration=<s>"]
    end

    subgraph PythonAI ["zoo-monitor AI Engine"]
        Worker["Inference Workers (YOLOv11s)"]
        API["FastAPI Engine (:8000)<br/>MJPEG Live Preview & Snapshots"]
        Disp["Analytics Dispatcher"]
    end

    subgraph Dashboard ["zoo-analytics-web (:3000)"]
        LivePage["/live Camera Grid"]
        EventsPage["/events Table<br/>[Bukti: Snapshot + Play Clip]"]
        ClipProxy["/api/clip Proxy"]
    end

    Cam1 --> Puller
    Cam2 --> Puller
    Sim --> Puller
    Puller --> Recorder
    Puller --> RTSPReServer
    Recorder --> PlaybackAPI

    RTSPReServer -->|Single TCP connection per cam| Worker
    Worker --> Disp
    Worker --> API
    Disp -->|Telemetry + recordingPath| EventsPage
    API -->|Live MJPEG & Frame| LivePage
    PlaybackAPI -->|30s Event MP4 Clip| ClipProxy
    ClipProxy --> EventsPage
```

### Why MediaMTX?
1. **Camera Protection**: Pulls each physical IP camera only **once** over TCP. The AI engine, operators, and recording engine read from MediaMTX locally, preventing camera CPU exhaustion.
2. **24/7 Rolling Archive**: Automatically splits recordings into 10-minute `.mp4` chunks on disk and prunes segments older than the retention window (e.g. 7 days).
3. **Forensic Event Clips**: Serves exact 30-second video clips (`-15s` before to `+15s` after an alert) via a high-speed HTTP endpoint for instant review in the web dashboard.
4. **Zero License Fees**: Completely open source, standalone, and resource-efficient (~30MB RAM).

---

## 2. Port Allocation & Network Map

| Port | Protocol | Purpose | Consumer |
|---|---|---|---|
| **`8554`** | RTSP (TCP) | RTSP stream proxy / re-broadcast | `zoo-monitor` (`main.py` cameras.yaml `source`) |
| **`9996`** | HTTP | Archive playback & clip extraction API | `zoo-analytics-web` (`/api/clip` endpoint) |
| **`8889`** | HTTP/WebRTC | Low-latency raw browser video stream | Optional browser fallback |

---

## 3. Installation Methods (Windows & Docker)

### Option A: Portable Windows Binary (Recommended for Local Dev)
MediaMTX is a single standalone executable with no external runtime dependencies.

1. Download the latest Windows release (`mediamtx_v1.21.1_windows_amd64.zip`):
   - Direct GitHub link: [https://github.com/bluenviron/mediamtx/releases](https://github.com/bluenviron/mediamtx/releases)
2. Extract `mediamtx.exe` into a folder (e.g. `c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\mediamtx\` or place directly in project).
3. Verify by running in PowerShell:
   ```powershell
   .\mediamtx.exe --version
   ```

### Option B: Docker / Docker Compose (Linux or Windows with Docker Desktop)
A complete service definition is already configured in [`docker-compose.yml`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docker-compose.yml):

```powershell
# Start MediaMTX service in the background:
docker compose up -d mediamtx

# Check logs:
docker compose logs -f mediamtx
```

---

## 4. Configuration (`configs/mediamtx.yml`) Explained

The project configuration file is located at [`configs/mediamtx.yml`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/configs/mediamtx.yml):

```yaml
authInternalUsers:
  # Allow localhost and private subnet reading without password
  - user: any
    pass:
    ips: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
    permissions:
      - action: read
      - action: playback
  # Only local processes can publish test streams or call admin API
  - user: any
    pass:
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: publish
      - action: api
      - action: metrics

# Enabled protocols
playback: true                  # Enables HTTP playback server on port 9996
rtmp: false
hls: false
srt: false
moq: false

pathDefaults:
  rtspTransport: tcp            # TCP prevents UDP packet drops and frame artifacts
  record: true                  # Enable 24/7 continuous recording
  recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S-%f  # File naming scheme
  recordSegmentDuration: 10m    # Chunk length
  recordDeleteAfter: 7d         # Retention: automatically deletes chunks older than 7 days

# Camera Path Definitions
paths:
  # MODE A: Local MP4 Simulation (Loops local files as 24/7 RTSP streams)
  cam_cashier_01:
    runOnInit: ffmpeg -re -stream_loop -1 -i "C:/Users/Magnet Busdev-2/Videos/vlc-record-2026-10-02-19h41m49s-kasir.mp4-.mp4" -c copy -an -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/cam_cashier_01
    runOnInitRestart: yes

  cam_restaurant_01:
    runOnInit: ffmpeg -re -stream_loop -1 -i "C:/Users/Magnet Busdev-2/Videos/vlc-record-2026-10-02-19h46m00s-restoran.mp4-.mp4" -c copy -an -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/cam_restaurant_01
    runOnInitRestart: yes

  cam_gate_entry_01:
    runOnInit: ffmpeg -re -stream_loop -1 -i "C:/Users/Magnet Busdev-2/Videos/vlc-record-2026-10-02-19h48m37s-gateway_kendaraan.mp4-.mp4" -c copy -an -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/cam_gate_entry_01
    runOnInitRestart: yes

  cam_horse_01:
    runOnInit: ffmpeg -re -stream_loop -1 -i "C:/Users/Magnet Busdev-2/Videos/vlc-record-2026-09-30-14h55m15s-horse_riding.mp4-.mp4" -c copy -an -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/cam_horse_01
    runOnInitRestart: yes

  # MODE B: Production Real IP Cameras (MediaMTX pulls automatically)
  # cam_cashier_01:
  #   source: rtsp://user:pass@192.168.1.50:554/stream1
```

> [!IMPORTANT]
> **Video Codec Requirement**: Always configure physical IP cameras to encode in **H.264** (not H.265). Browsers can play H.264 natively in HTML5 `<video>` tags without transcoding.

---

## 5. Step-by-Step Testing & Verification

Follow these steps to verify MediaMTX locally on your machine without physical cameras:

### Step 1: Start MediaMTX

Run MediaMTX pointing to the project configuration:

```powershell
# From zoo-monitor directory:
.\mediamtx.exe configs\mediamtx.yml
```

You should see log output confirming:
```text
INF MediaMTX v1.21.1
INF [RTSP] listener opened on :8554 (TCP)
INF [playback] listener opened on :9996
```

---

### Step 2: Publish Simulated Camera Feeds with FFmpeg

Since you have recorded test videos in `sample_data/` or `Downloads/`, you can loop an `.mp4` into MediaMTX as an RTSP live stream using FFmpeg:

```powershell
# In a new PowerShell window, publish a looped RTSP stream for the restaurant camera:
ffmpeg -re -stream_loop -1 -i "C:/Users/Magnet Busdev-2/Downloads/restoran.mp4" -c:v copy -an -f rtsp rtsp://127.0.0.1:8554/cam_restaurant_01
```

* `-re`: Reads input at native frame rate (real-time simulation).
* `-stream_loop -1`: Loops the video indefinitely.
* `-c:v copy`: Zero-CPU copy (no re-encoding).
* `-f rtsp rtsp://127.0.0.1:8554/cam_restaurant_01`: Pushes into MediaMTX.

MediaMTX logs will print:
```text
INF [RTSP] [session ...] is publishing to path 'cam_restaurant_01'
INF [recorder] [path cam_restaurant_01] opened slice ./recordings/cam_restaurant_01/...
```

---

### Step 3: Verify RTSP Ingestion & Playback

Verify that MediaMTX is successfully re-broadcasting the RTSP feed:

```powershell
# Test with ffplay:
ffplay -rtsp_transport tcp rtsp://127.0.0.1:8554/cam_restaurant_01

# Or open VLC Media Player -> Media -> Open Network Stream:
# URL: rtsp://127.0.0.1:8554/cam_restaurant_01
```

You should see the live looped video playing smoothly without latency.

---

### Step 4: Verify Disk Recording

Check the `./recordings` directory:
```powershell
Get-ChildItem -Path ./recordings/cam_restaurant_01 -Recurse
```
You will find `.mp4` segment files being written continuously.

---

### Step 5: Test HTTP Clip Playback API (`:9996`)

MediaMTX includes a playback engine that stitches recorded chunks on-the-fly into an MP4 clip:

```powershell
# Query MediaMTX for a 30-second clip starting at a specific UTC timestamp:
# Replace the timestamp with the current UTC time (e.g. 1 minute ago)
$now = [DateTime]::UtcNow.AddSeconds(-30).ToString("yyyy-MM-ddTHH:mm:ssZ")
curl "http://127.0.0.1:9996/get?path=cam_restaurant_01&start=$now&duration=30&format=mp4" -o test_clip.mp4
```

* Open `test_clip.mp4` in Windows Media Player or VLC. The clip should play cleanly!

---

## 6. End-to-End Integration with Web Dashboard & AI Engine

Once MediaMTX is verified, connect both `zoo-monitor` and `zoo-analytics-web`:

### 1. Configure `zoo-monitor/configs/cameras.yaml`
Point the camera source to MediaMTX and specify `recording_path`:

```yaml
cameras:
  - id: "cam_restaurant_01"
    name: "Safari Cafe Dining Hall"
    source: "rtsp://127.0.0.1:8554/cam_restaurant_01"    # Ingest from MediaMTX proxy
    recording_path: "cam_restaurant_01"                  # Must match MediaMTX path for clips!
    pipeline: "restaurant"
    target_fps: 15
    enabled: true
    rule_config: "configs/rules/restaurant_counter.yaml"
```

### 2. Configure `zoo-analytics-web/.env.local`
Enable the playback URL in the dashboard:

```env
AI_ENGINE_URL=http://127.0.0.1:8000
MEDIAMTX_PLAYBACK_URL=http://127.0.0.1:9996
```

### 3. Run the Multi-Camera Service
```powershell
cd c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor
python main.py
```

### 4. Verify in Web Dashboard
1. Open [`http://localhost:3000/restaurant`](http://localhost:3000/restaurant) and [`http://localhost:3000/events`](http://localhost:3000/events).
2. When an alert occurs (e.g. Capacity Alert or Seating change), check the **Bukti** column in the event table.
3. You will see both the **Snapshot image** and a **Putar Klip (Play Clip)** link.
4. Clicking "Putar Klip" will fetch the 30-second clip directly from MediaMTX via Next.js `/api/clip` and play it inside an interactive modal!

---

## 7. Troubleshooting & FAQ

### 1. "MediaMTX unreachable" in Dashboard
* **Check**: Is MediaMTX running? Test by opening `http://127.0.0.1:9996` in your browser.
* **Check**: Verify `MEDIAMTX_PLAYBACK_URL=http://127.0.0.1:9996` is set in `zoo-analytics-web/.env.local` and restart `npm start`.

### 2. "recording not available" (HTTP 404)
* **Check**: MediaMTX only serves clips for times that have **already elapsed** and were actually recorded on disk. If you just started publishing 5 seconds ago, request clips from the current minute.
* **Check**: Verify that the camera's `recording_path` in `cameras.yaml` exactly matches the path name in MediaMTX.

### 3. High CPU usage on MediaMTX
* MediaMTX uses virtually 0% CPU when remuxing and recording because it does not transcode.
* If CPU is high, verify that you are not running FFmpeg with software re-encoding (always use `-c:v copy`).

### 4. Browser cannot play clip (Black screen / Audio only)
* The camera stream is likely encoding in **H.265 (HEVC)**, which is unsupported by many web browsers.
* **Solution**: Switch camera video settings to **H.264 Baseline or Main profile**.

### 5. "reader is too slow, discarding frames" in MediaMTX / "Could not find ref with POC" in Python
* **Cause**: MediaMTX is streaming at native camera speed (~15–25 FPS per camera = ~80 FPS total across 4 cameras), but the Python AI engine is running on **CPU**. A desktop CPU can process ~5 to 8 YOLO detections per second total. When Python falls behind, MediaMTX drops buffered frames to prevent latency lag.
* **Fix**:
  * **For CPU testing**: Lower camera `target_fps` in [`configs/cameras.yaml`](cameras.yaml) (e.g. 2–5 FPS), or test cameras individually using [`test_video.py`](../test_video.py).
  * **For Production**: Set `device: "cuda:0"` in [`configs/app_config.yaml`](app_config.yaml) on an NVIDIA GPU (RTX 3060/4060 or TensorRT) to process 120+ FPS in real time with zero dropped frames.

