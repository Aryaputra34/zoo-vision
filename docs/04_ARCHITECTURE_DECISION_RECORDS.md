# 04. Architecture Decision Records (ADRs)

A curated collection of technical architectural decisions, rationale, empirical benchmarks, and validation criteria for the **Zoo & Safari Computer Vision & VMS System**.

Detailed ADR markdown records are located in the [docs/adr/](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/README.md) directory.

---

## Executive Summary of Key Architectural Decisions

### 1. [ADR-001: Multi-Camera Decoupled Pipeline & Inline ROI Architecture](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-001-multi-camera-inline-roi-architecture.md)
* **Question**: In an estate of dozens of cameras with different angles and booth layouts, do we need separate pipeline code for each camera?
* **Decision**: Decouple pipeline execution from camera geometry. A single generic `CashierPresencePipeline` class is reused across all booths. Each camera in [configs/cameras.yaml](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/configs/cameras.yaml) specifies its own inline `roi` (or rule overrides), with fallback to shared rule templates in `configs/rules/`.
* **Outcome**: Zero code duplication; new booths are onboarded purely via configuration.

---

### 2. [ADR-002: Cashier Dual-Zone Presence & Customer Queue Monitoring](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-002-cashier-dual-zone-presence-and-queue-monitoring.md)
* **Question**: How do we prevent customers outside the ticket window from being mistaken for the cashier, and how do we monitor customer service SLA?
* **Decision**: Implement a **Dual-Zone 4-State Machine**:
  - `clerk_zone`: Covers cashier chair and behind-the-counter desk.
  - `visitor_zone`: Covers queue lane facing the window.
  - States: `SERVING CUSTOMER`, `CASHIER PRESENT (IDLE)`, `DESK UNATTENDED`, `ALERT: CUSTOMER WAITING`.
* **Outcome**: Differentiates idle staff from busy staff; escalates urgent alerts when visitors are waiting at an empty desk.

---

### 3. [ADR-003: Vision Model Selection for Overhead Perspective (YOLO11s vs. YOLO26)](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-003-vision-model-selection-yolo11s-overhead-perspective.md)
* **Question**: Can we use YOLO26 (which excelled in restaurant crowd counting) for the cashier booth?
* **Decision**: Benchmark revealed YOLO26 completely failed (0.00 confidence) on overhead seated postures due to foreshortening and monitor occlusion. We standardized on **`yolo11s.pt`** (`confidence_threshold: 0.22`), which achieves **0.88–0.94** confidence consistently across all postures on CPU at ~155ms latency.
* **Outcome**: 100% detection accuracy on seated cashier leaning over phone, standing, or walking away.

---

### 4. [ADR-004: Queue Depth Segmentation & Dwell-Time Filtering to Reject Pedestrian False Positives](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-004-queue-depth-and-dwell-time-filtering.md)
* **Question**: How do we prevent pedestrians walking behind the retractable blue queue ribbon from triggering false "Customer Waiting" alarms?
* **Decision**: Two-pronged strategy:
  1. Spatially restrict `visitor_zone` to the foreground queue lane (`y: 0.12 - 0.46`, `x: 0.36 - 0.64`).
  2. Temporal dwell-time filter (`min_waiting_confirm_sec: 3`): Pedestrians crossing in 1–2s are filtered out with zero alarms; legitimate customers stationary for $\ge 3$s trigger the alert reliably.
* **Outcome**: Validated against video footage — 0 false alarms at `16:20` (passerby), while reliably detecting true customer waiting at `29:48 – 30:05`.
