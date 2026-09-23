# Zoo & Safari Computer Vision System (with Nx Witness / Nx Meta)

An intelligent video analytics (IVA) and revenue assurance system integrated with **Network Optix (Nx Witness / Nx Meta) VMS**, targeting **5 key attraction use cases** across a 300-camera park estate.

---

## 📚 Complete Project Documentation

All project documentation is structured inside the [`docs/`](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/) folder:

1. **[01_IMPLEMENTATION_PLAN.md](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/01_IMPLEMENTATION_PLAN.md)**
   * Executive scope across the 300-camera estate.
   * Full 5 Use Case Matrix (Difficulty, Technical Approach, Dependencies).
   * 4-Phase Delivery Schedule & Milestones (Phase 1 Quick Wins $\to$ Phase 4 Feeding Classifier).
   * System Architecture, Nx Clustered Server Topology, and Project Directory Structure.

2. **[02_MODEL_BUILDING_GUIDE.md](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/02_MODEL_BUILDING_GUIDE.md)**
   * Framework selection rationale: **Why PyTorch (and why NOT TensorFlow)**.
   * Transfer Learning Breakdown by Use Case (Tier 1 Zero Training vs. Tier 2 Fine-Tuning vs. Tier 3 Custom).
   * Step-by-step Jupyter Notebook training workflow (Ultralytics YOLOv11 + ByteTrack).
   * 1-Click NVIDIA TensorRT FP16 export guide (`model.export(format='engine')`).
   * Indonesian License Plate OCR (PaddleOCR PP-OCRv4 + regex validation).

3. **[03_HARDWARE_SPECIFICATIONS.md](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/03_HARDWARE_SPECIFICATIONS.md)**
   * Workload compute sizing for 5–10 cameras (~70 to 100 aggregate FPS).
   * VRAM sizing breakdown (~6.0 GB required, 12GB GPU recommended).
   * Bill of Materials: Workstation Build ($1,400–$1,850) vs. 4U Rackmount Server ($3,200–$4,500) vs. OEM (Dell/Lenovo/HPE).
   * Single-NIC Nx-proxied network topology & UPS battery backup recommendations.

---

## 🎯 The 5 Core Use Cases

| # | Use Case | Difficulty | Models Used | Transfer Learning Required? |
| :-: | :--- | :---: | :--- | :---: |
| **1** | **Vehicle Entry/Exit & LPR** | **Easy** | YOLOv11s + ByteTrack + PaddleOCR | ❌ No (Pre-trained COCO + standard OCR) |
| **2** | **Cashier Presence Check** | **Easy** | YOLOv11n (`person` @ 0.2 FPS) | ❌ No (Pre-trained COCO) |
| **3** | **Restaurant People Counter**| **Easy** | YOLOv11s (`person`) + ByteTrack | ❌ No (Pre-trained COCO) |
| **4** | **Horse-Riding Revenue Count**| **Easy–Med**| YOLOv11m + ByteTrack (Choke Point) | ⚠️ Minor (~200 frames for rider vs. handler) |
| **5** | **Feeding-Item Classification**| **Hard** | Custom YOLOv11m/x (Carrots vs. Kresek)| ✅ Yes (Custom dataset across feeding windows) |

---

## 🚀 4-Phase Delivery Schedule

* **Phase 1: Foundation & Quick Wins (Est. 4–8 Weeks)**: Deploy ~5–6 clustered Nx Witness servers for live view of 300 cameras; launch Vehicle Gate, Cashier Presence, and Restaurant Counter on Day 1.
* **Phase 2: Horse-Riding Revenue Audit (Est. 6–10 Weeks)**: Mount choke-point model fine-tuning, debounced line-crossing, and ticket reconciliation testing.
* **Phase 3: Feeding Site Survey & Cabling (Pending Walk-Through)**: Physical survey of platforms, reframing vs. new close-in cameras, network drop cable runs.
* **Phase 4: Feeding Classification Model (Est. 3–6+ Months)**: Dataset harvesting during daily feeding windows, fine-grained model training (plastic bags / wrappers), and operational SLA agreement.

---

## 🛠️ Technology Stack Summary

* **Deep Learning Framework**: PyTorch 2.3+ (CUDA 12)
* **Object Detection Backbone**: Ultralytics YOLOv11 (`yolo11n`, `yolo11s`, `yolo11m`)
* **Tracking Algorithm**: ByteTrack (Kalman Filter + motion trajectory)
* **License Plate OCR**: PaddleOCR (PP-OCRv4) with Indonesian regex syntax
* **Inference Accelerator**: NVIDIA TensorRT 10.x (FP16 `.engine`)
* **VMS Platform**: Network Optix (Nx Witness / Nx Meta) via REST API v3 & RTSP restreaming
* **Deployment**: Docker Engine + NVIDIA Container Toolkit on Ubuntu Server 22.04 LTS
