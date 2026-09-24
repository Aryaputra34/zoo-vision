# Architecture Decision Records (ADRs)

This directory documents the key architectural and design decisions made for the **Zoo & Safari Computer Vision Analytics Platform**.

---

## Index of Records

| ADR ID | Title | Status | Date | Key Impact |
| :--- | :--- | :---: | :---: | :--- |
| **[ADR-001](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-001-multi-camera-inline-roi-architecture.md)** | **Multi-Camera Decoupled Pipeline & Inline ROI Architecture** | `Accepted` | 2026-09-23 | Decouples pipeline logic from physical layouts; allows inline `roi:` per camera in `cameras.yaml` with zero code duplication. |
| **[ADR-002](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-002-cashier-dual-zone-presence-and-queue-monitoring.md)** | **Cashier Dual-Zone Presence & Customer Queue Monitoring** | `Accepted` | 2026-09-23 | Replaces single ROI with `clerk_zone` + `visitor_zone`; tracks 4 operational states (`SERVING`, `IDLE`, `UNATTENDED`, `CUSTOMER WAITING`). |
| **[ADR-003](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-003-vision-model-selection-yolo11s-overhead-perspective.md)** | **Vision Model Selection for Overhead Perspective (YOLO11s vs. YOLO26)** | `Accepted` | 2026-09-23 | Empirical benchmark proving YOLO11s (0.88–0.94 conf) vastly outperforms YOLO26 on overhead, seated cashier angles with partial occlusion. |
| **[ADR-004](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-004-queue-depth-and-dwell-time-filtering.md)** | **Queue Depth Segmentation & Dwell-Time Filtering to Reject Pedestrian False Positives** | `Accepted` | 2026-09-23 | Separates foreground queue bay from background walkway behind blue ribbon via refined ROI + `min_waiting_confirm_sec: 3` dwell-time filter. |
| **[ADR-005](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/docs/adr/ADR-005-indonesian-license-plate-recognition-anpr-gateway.md)** | **Indonesian License Plate Recognition (ANPR / LPR) for Vehicle Gateway Audit** | `Accepted` | 2026-09-24 | 2-stage YOLO11 ONNX plate detector + OCR with Indonesian TNKB regional code parser & tax stamp filter for vehicle audit. |

---

## Format & Governance
These ADRs follow the [MADR](https://adr.github.io/madr/) specification to ensure transparent engineering trade-offs, reproducible benchmarks, and verifiable production criteria.
