# Detailed Hardware Specification: Zoo AI Computer Vision Server
**Workload Sizing, Component Selection, and Deployment Topology**

Targeting **5 to 10 concurrent AI camera streams** across:
1. Animal Riding Platform (1–2 cameras @ 5–8 FPS)
2. Vehicle Entry/Exit Gates (2–4 cameras @ 12–15 FPS)
3. Feeding Attraction Stations (2–4 cameras @ 8–10 FPS)
*Total AI Ingest Workload: ~70 to 100 frames per second (FPS) aggregate.*

---

## 1. Workload & Compute Resource Sizing

### A. GPU Memory (VRAM) Sizing
Running 3 specialized deep learning pipelines across 10 streams requires memory allocation for individual model weights, CUDA contexts, frame buffers, and OCR engine:

| Component | Quantity / Scope | VRAM Usage |
| :--- | :--- | :--- |
| **CUDA Driver & PyTorch Context** | Base initialization | ~800 MB |
| **YOLOv11 Riding Model** (person, camel, horse, pony) | Dedicated engine for riding cameras | ~400 MB |
| **YOLOv11 Vehicle + Plate Localizer Model** (car, bus, truck, motorcycle, plate) | Dedicated engine for gate cameras | ~500 MB |
| **YOLOv11 Feeding Hazard Model** (kresek, wrapper, bread, hand, animal_mouth) | Dedicated engine for feeding cameras | ~400 MB |
| **PaddleOCR / CRNN Text Recognition** | Indonesian plate character sequence model | ~900 MB |
| **NVDEC Hardware Video Decoding Buffers** | 10 active 1080p RTSP streams (ring buffer) | ~1,500 MB (150 MB / stream) |
| **Inference Intermediate Tensors & Headroom** | Peak batch surges | ~1,500 MB |
| **Total Estimated VRAM Required** | — | **~6.0 GB** |

> [!IMPORTANT]
> A GPU with at least **12 GB VRAM** is required to run all pipelines with comfortable safety margin (~50% headroom) and avoid Out-Of-Memory (OOM) crashes under peak visitor surges.

---

### B. Network Bandwidth Sizing
* 10 cameras streaming 1080p (Full HD, 1920x1080) @ H.264 / H.265:
  * Bitrate per camera: **4 to 6 Mbps** (standard commercial IP camera stream).
  * 10 cameras $\times$ 5 Mbps = **~50 Mbps** incoming network throughput.
* **Requirement**: Standard **1 Gbps (Gigabit Ethernet)** network interface is more than sufficient.

---

## 2. Component-by-Component Hardware Specification

### Build Option A: Workstation / Tower (Best Value & Easy Sourcing)
*Ideal for an office, control room, or standard cabinet.*

| Component | Recommended Specification | Minimum Specification |
| :--- | :--- | :--- |
| **GPU** | **NVIDIA GeForce RTX 4070 (12GB GDDR6X)** or **RTX 3060 (12GB GDDR6)** | NVIDIA RTX 3060 (12GB GDDR6) |
| **Processor (CPU)** | **Intel Core i7-14700** (20 Cores / 28 Threads, up to 5.4 GHz) or **AMD Ryzen 7 7700X** (8 Cores / 16 Threads) | Intel Core i5-13600K or AMD Ryzen 5 7600 |
| **System Memory (RAM)**| **32 GB (2x 16GB) DDR5 5600MHz** (Dual-Channel) | 32 GB DDR4 3200MHz |
| **Primary OS Storage** | **1 TB NVMe M.2 PCIe 4.0 SSD** (Read: 5000+ MB/s, e.g., Samsung 980 Pro / WD Black SN770) | 512 GB NVMe M.2 SSD |
| **Motherboard** | Intel B760 / Z790 chipset or AMD B650 with PCIe 4.0 x16 slot & 2.5 GbE LAN | Standard B660 / B550 |
| **Power Supply (PSU)** | **750W 80-Plus Gold Certified** (Fully Modular, e.g., Corsair RM750e / Seasonic Focus) | 650W 80-Plus Bronze |
| **Network Interface** | Integrated **1 GbE or 2.5 GbE RJ-45 LAN port** | 1 GbE RJ-45 |
| **Cooling** | High-efficiency dual-tower air cooler (e.g., DeepCool AK620 or Noctua NH-D15) + 3x 120mm case intake fans | Standard Tower Cooler |
| **Chassis** | Mid-Tower ATX with high airflow mesh front (e.g., Fractal Design Pop Air / Corsair 4000D Airflow) | Standard ATX Case |
| **Approximate Cost** | **$1,400 – $1,850 USD** | **~$1,100 USD** |

---

### Build Option B: 2U / 4U Rackmount Server (For Data Center / Server Room)
*Ideal if the zoo has an existing 19-inch equipment rack in a central server room.*

| Component | Specification | Notes |
| :--- | :--- | :--- |
| **Form Factor** | **4U Rackmount** (recommended for standard GPU cooling) or **2U Rackmount** (requires blower-style or single-slot GPU) | 4U chassis allows using quiet, high-efficiency 120mm fans and standard PCIe cards. |
| **GPU** | **NVIDIA RTX A4000 (16GB)** or **NVIDIA L4 (24GB)** (Enterprise datacenter GPUs) *Alternative: RTX 4070 in a 4U chassis* | RTX A4000/L4 are single-slot / 70W low-power cards designed for 24/7 server racks. |
| **Processor (CPU)** | **Intel Xeon Silver 4410Y** (12 Cores / 24 Threads) or **AMD EPYC 7302P** (16 Cores) | Server-grade reliability with ECC memory support. |
| **System Memory (RAM)**| **32 GB or 64 GB DDR4/DDR5 Registered ECC RAM** | Error-Correcting Code prevents bit-flip crashes during months of continuous uptime. |
| **Storage** | 2x 960GB Enterprise SATA/NVMe SSD configured in **Hardware RAID 1 (Mirrored)** | OS and application redundancy against drive failure. |
| **Power Supply (PSU)** | **Dual Redundant 550W – 800W Platinum PSUs** (Hot-swappable) | If one power supply or circuit fails, system remains online. |
| **Network** | Dual 1 GbE / 10 GbE Intel NICs | Dual NIC allows physical separation of Camera Network (VLAN 1) from Office/VMS Network (VLAN 2). |
| **Approximate Cost** | **$3,200 – $4,500 USD** | Enterprise pricing with warranty and redundancy. |

---

### Build Option C: Pre-Built Commercial OEM Servers (Off-The-Shelf)
If the client prefers to purchase from recognized enterprise vendors with on-site warranty (e.g., Dell, HP, Lenovo):
1. **Dell PowerEdge R760 / T560** (with NVIDIA L4 or RTX A4000)
2. **Lenovo ThinkSystem SR650 V3**
3. **HPE ProLiant DL380 Gen11**

---

## 3. Network Architecture & Restreaming Proxy

The AI Computer Vision Server ingests RTSP streams **republished by the Nx Meta Media Server** (not directly from cameras). This means the AI server only needs a **single network interface** on the same VLAN as the Nx Server:

```
[300 Zoo IP Cameras]
       │
       ▼ (RTSP / ONVIF)
 [PoE Access Switches]
       │ (Camera VLAN 10 - Isolated Subnet: 192.168.10.x)
       ▼
 ┌──────────────────────────────────────────────────────────┐
 │         SERVER 1: Nx Meta Media Server                   │
 │  • Records all 300 cameras to disk 24/7                  │
 │  • Republishes RTSP sub-streams for AI consumption       │
 │  • NIC 1: Camera VLAN (192.168.10.x)                     │
 │  • NIC 2: Corporate / VMS VLAN (10.10.20.x)              │
 └────────────────────────┬─────────────────────────────────┘
                          │ (Corporate / VMS VLAN 20 - 10.10.20.x)
                          │  RTSP streams (5-10 cameras only)
                          │  + REST API v3 (Bookmarks & Events)
                          ▼
 ┌──────────────────────────────────────────────────────────┐
 │         SERVER 2: AI Computer Vision Server              │
 │  • Single NIC on Corporate / VMS VLAN (10.10.20.x)       │
 │  • Pulls RTSP from Nx Server (not directly from cameras) │
 │  • Pushes Bookmarks & Events back to Nx via REST API     │
 └──────────────────────────────────────────────────────────┘
                          │
                          ▼
 ┌──────────────────────────────────────────────────────────┐
 │           Nx Desktop Client (Auditors)                   │
 │  • View live cameras, search audit bookmarks             │
 │  • Filter by tag (#ride_audit, #vehicle_audit)           │
 │  • Export bookmark reports to CSV / PDF                  │
 └──────────────────────────────────────────────────────────┘
```

---

## 4. Software Stack & Operating System Requirements

| Layer | Recommended Version | Purpose |
| :--- | :--- | :--- |
| **Operating System** | **Ubuntu Server 22.04 LTS (Jammy Jellyfish)** or **24.04 LTS** | Long-Term Support, standard Linux AI production environment. |
| **NVIDIA Driver** | **NVIDIA Driver 550.x or 535.x (Production Branch)** | Stable GPU kernel driver. |
| **CUDA Toolkit** | **CUDA 12.2 or 12.4** | GPU computing runtime. |
| **cuDNN** | **cuDNN 9.x** | Deep neural network primitives. |
| **Inference Accelerator** | **TensorRT 10.x** | Optimizes YOLOv11 and OCR models for sub-10ms FP16 inference. |
| **Container Engine** | **Docker Engine 26.x + NVIDIA Container Toolkit** | Allows entire AI microservice to be deployed as a single command. |
| **Python Environment** | Python 3.10 / 3.11 with PyTorch 2.3+ (CUDA 12 build) | Core application execution. |

---

## 5. UPS (Uninterruptible Power Supply) Recommendation

| Component | Recommendation |
| :--- | :--- |
| **AI Server UPS** | **APC Smart-UPS 1500VA / 1000W** (Line-Interactive, Pure Sine Wave) or equivalent CyberPower / Eaton unit. Provides ~10–15 minutes of runtime for graceful Docker container shutdown. |
| **Nx VMS Server UPS** | **APC Smart-UPS 2200VA / 1980W** or rackmount equivalent. Protects RAID storage arrays from corruption during mid-write power loss. |
| **Network Switch UPS** | Ensure PoE switches feeding the 5–10 AI cameras are also on UPS-backed circuits. |
