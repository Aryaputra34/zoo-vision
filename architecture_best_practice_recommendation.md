# Architectural Blueprint & Best Practice: Nx Meta + Python AI Microservice + Web Analytics

**Document Version:** 1.0  
**Project:** Zoo & Safari Computer Vision Monitoring  
**Target Systems:** Network Optix (Nx Meta / Nx Witness VMS) + Python AI Engine (`zoo-monitor`) + Web Analytics Dashboard (`zoo-analytics-web`)

---

## 1. Executive Summary & Verdict

### The Core Question
> *"Should we use an Nx MetaVMS plugin, or use Python microservices, given that we still need web dashboard analytics?"*

### The Architectural Verdict: **Decoupled Python AI Microservice with Nx Backbone**
For computer vision systems requiring **business analytics, web dashboards, multi-zone state tracking (cashier queues, dining tables, gate ANPR), and rapid model iteration**, developing a **Native C++ Nx Meta Plugin is an anti-pattern**. 

The **industry best practice** is a **Python AI Microservice architecture** that leverages **Nx Meta as the Video & Bookmark Backbone**:

```mermaid
graph LR
    subgraph Cameras ["Physical IP Cameras (300 Camera Estate)"]
        C1["RTSP IP Camera 1"]
        C2["RTSP IP Camera 2"]
    end

    subgraph NxServer ["Network Optix MetaVMS Server"]
        NxRec["24/7 Continuous Recording & Storage"]
        NxProxy["RTSP Live Stream Proxy (:7001)"]
        NxBM["Timeline Bookmarks & Event Engine"]
        NxHLS["Built-in WebRTC / HLS Engine"]
    end

    subgraph PythonAI ["Python AI Engine (zoo-monitor)"]
        Inference["YOLOv11s + ByteTrack"]
        Logic["Domain Rules & State Machines<br/>(Cashier, Tables, Gate, Horses)"]
        FastAPI["Embedded FastAPI Server<br/>(On-Demand 5 FPS MJPEG + Health API)"]
        Dispatcher["Analytics Dispatcher (Async Queue)"]
    end

    subgraph Egress ["User Interfaces & Dashboards"]
        WebDash["Web Analytics Dashboard (zoo-analytics-web)<br/>- Operational KPIs & Heatmaps<br/>- On-Demand Live Preview<br/>- Event Snapshots + [Open in Nx] Link"]
        NxClient["Nx Witness Desktop Client<br/>- Security Guards Live Wall<br/>- Timeline Bookmarks & Scrubbing<br/>- Native Forensic Video Archive"]
    end

    Cameras -->|RTSP| NxRec
    NxRec --> NxProxy
    NxProxy -->|RTSP Stream| Inference
    Inference --> Logic
    Logic -->|Async HTTP POST /api/events| Dispatcher
    Dispatcher -->|Batch Delivery| WebDash
    Logic -->|REST API v3 Bookmarks| NxBM
    FastAPI -.->|On-Demand MJPEG (5 FPS)| WebDash
    WebDash -.->|nx:// Desktop Deep Link| NxClient
```

---

## 2. In-Depth Architectural Comparison

| Dimension | Native C++ Nx Plugin (`magnet_nx_plugin`) | Decoupled Python Microservice (`zoo-monitor`) | Verdict |
| :--- | :--- | :--- | :--- |
| **System Stability & Crash Blast Radius** | **CRITICAL RISK:** The plugin runs in-process inside `networkoptix-metavms-mediaserver`. A C++ segfault or memory leak crashes the entire VMS recording server for all 300 cameras. | **ISOLATED:** Python runs as a separate container or systemd service. An AI crash has **zero effect** on camera recording or Nx video storage. | 🏆 **Python Microservice** |
| **Web Dashboard Integration** | **HIGH FRICTION:** Nx plugins emit internal VMS metadata packets. Feeding an external Next.js/React web dashboard requires custom C++ networking or complex Nx REST API polling. | **NATIVE & SEAMLESS:** Python natively formats JSON payloads and pushes events directly to `zoo-analytics-web` via [`AnalyticsDispatcher`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/core/analytics_dispatcher.py). | 🏆 **Python Microservice** |
| **Business Logic Agility** | **SLOW & RIGID:** Complex multi-step state machines (table occupancy states, cashier dwell timers, PaddleOCR license plate regex) require C++ code, recompilation, and VMS service restarts. | **RAPID ITERATION:** Python ecosystem (Shapely, OpenCV, Supervision, NumPy, Pandas) allows instant tuning of zone coordinates and logic. | 🏆 **Python Microservice** |
| **Visual In-Client Bounding Boxes** | **NATIVE:** Draws bounding boxes and object tracks directly inside the Nx Witness Desktop Client player grid. | **NOT IN NX PLAYER:** Bounding boxes are not drawn inside Nx Desktop. However, they are visible in the Web Dashboard on-demand and on event snapshots. | ⚖️ **Nx Plugin** (Only if guards must see boxes inside Nx) |
| **Timeline Bookmarks & Auditing** | Supported internally via Nx Event metadata. | Fully supported via Nx REST API v3 ([`NxClient.create_bookmark`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/nx_integration/nx_client.py#L74-L98)). Guards see searchable bookmarks in Nx Desktop! | 🏆 **Tie** |
| **Development & Maintenance Cost** | Extremely high (C++ CMake, SDK headers, memory management, YUV420 color conversions, ADR-006 track lifetime issues). | Low to moderate (Standard Python, PyTorch, Docker). | 🏆 **Python Microservice** |

---

## 3. Detailed Component Architecture

### 3.1. Ingestion: Why Use Nx as the Video Proxy?
Instead of pointing the Python microservice directly to physical IP camera IPs:
1. **Network Offloading**: 300 cameras on a park network have limited RTSP encoders. Connecting multiple AI workers directly to cameras can saturate camera CPUs.
2. **Centralized Authentication**: Python connects to `rtsp://<nx-server>:7001/<nx_camera_id>` using Nx credentials.
3. **Automatic Reconnection & Codec Handling**: Nx buffers and manages camera drops gracefully.

### 3.2. Visual Strategy: On-Demand Stream + Event Snapshots
Continuous multi-camera video re-encoding (e.g., MJPEG/H.264 for 10+ cameras) wastes CPU/GPU. The agreed blueprint implements:
1. **Event Snapshot**: When a business rule triggers (e.g. cashier desk empty > 15s), the pipeline captures the current annotated frame as a compressed JPEG thumbnail and attaches it to the event payload.
2. **On-Demand Live Preview**: An embedded FastAPI endpoint serves a 5 FPS MJPEG stream (`/stream/{camera_id}`) **only** when an operator clicks on a camera card in the Web Dashboard. When no viewer is connected, encoding overhead is **zero**.
3. **Nx Deep Link**: Every alert card contains a `[View in Nx Witness]` button utilizing the `nx://` URI scheme:
   ```text
   nx://<nx-host>/camera/<nx-camera-uuid>?time=<timestamp_ms>
   ```
   Clicking this automatically launches the operator's native Nx Witness Desktop client and jumps directly to the incident recording on the timeline.

---

## 4. Implementation Blueprint: Embedded FastAPI & Streaming

To upgrade [`main.py`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/main.py) with zero IPC overhead:

### Step 1: Add Dependencies
```txt
# In requirements.txt:
fastapi>=0.111.0
uvicorn>=0.30.0
```

### Step 2: Architecture of the Embedded API Server
Run `uvicorn` in a dedicated background daemon thread inside `main.py`, sharing in-memory references to `active_pipelines`:

```python
# Conceptual Implementation in core/api_server.py
from fastapi import FastAPI, Response, HTTPException
from fastapi.responses import StreamingResponse
import cv2
import time

app = FastAPI(title="Zoo Vision AI Engine API")
pipelines_registry = {}  # camera_id -> pipeline instance

@app.get("/health")
def health():
    return {
        "status": "healthy",
        "cameras": [
            {
                "id": cid,
                "fps": p.current_fps,
                "status": "online" if p.is_alive else "offline"
            }
            for cid, p in pipelines_registry.items()
        ]
    }

@app.get("/stream/{camera_id}")
def stream_mjpeg(camera_id: str):
    if camera_id not in pipelines_registry:
        raise HTTPException(status_code=404, detail="Camera not found")

    pipeline = pipelines_registry[camera_id]

    def frame_generator():
        while True:
            frame = pipeline.get_latest_annotated_frame()
            if frame is not None:
                # Encode on-demand at ~70% JPEG quality
                _, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')
            time.sleep(0.2)  # Throttle to 5 FPS for on-demand browser view

    return StreamingResponse(frame_generator(), media_type="multipart/x-mixed-replace; boundary=frame")
```

---

## 5. Web Dashboard (`zoo-analytics-web`) Integration

1. **Dashboard Consumes**:
   - `POST /api/events` (Pushed asynchronously by [`AnalyticsDispatcher`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/core/analytics_dispatcher.py)).
   - `<img>` tag pointing to `http://<ai-server>:8000/stream/{camera_id}` for on-demand preview modal.
2. **Dashboard Persistence**:
   - Next.js API route writes incoming events to its existing SQLite/PostgreSQL database via Prisma.
3. **Operator Action**:
   - Clicking an alert opens the modal with the JPEG snapshot, stats, and the `nx://` deep link button.

---

## 6. Sizing & Hardware Recommendations

For 5 to 10 cameras at 2–5 FPS per camera:
* **Compute**: Intel i5/i7 (12th+ Gen) or AMD Ryzen 7 (8 cores / 16 threads).
* **GPU**: 1x NVIDIA RTX 3060 (12GB) or RTX 4060 Ti (16GB) running ONNX Runtime / TensorRT FP16.
* **VRAM**: ~5.5 GB total VRAM allocation for 5 parallel YOLOv11s pipelines.
* **Network**: 1Gbps dedicated NIC connected to the Nx Mediaserver switch.
