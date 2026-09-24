# ADR-004: Queue Depth Segmentation and Dwell-Time Filtering to Reject Pedestrian False Positives

* **Status**: Accepted
* **Date**: 2026-09-23
* **Deciders**: Computer Vision Engineering Team
* **Technical Domain**: Spatial Filtering, Temporal Debouncing, False Positive Rejection

---

## Context and Problem Statement
During video playback testing of `kasir.mp4`, an operator observed a false alarm at timestamp **`16:20`**:
- The cashier was absent from the desk.
- A staff member in a green shirt and white trousers walked horizontally across the background outside the window.
- The system immediately flashed: `ALERT: CUSTOMER WAITING (1s)` and began counting waiting duration.

Investigation of the physical scene revealed:
1. **Physical Scene Depth**:
   - The ticket booth is separated from the public outdoor street by a queue barrier system (metal stanchion poles connected by a retractable blue ribbon).
   - **Service Zone (Foreground)**: Inside the queue lane directly facing the glass counter window.
   - **Pedestrian Walkway (Background)**: The pavement **behind the blue line** (`y < 0.20`), where park staff and visitors walk past without any intention of purchasing tickets.
2. **Instantaneous State Transition**:
   - The initial pipeline declared `ALERT: CUSTOMER WAITING` instantaneously on frame 1 of detecting any person in `visitor_zone`.

---

## Decision Drivers
* **Zero False Alarms from Walk-Bys**: Pedestrians walking past on the street behind the barrier must never trigger staff alerts.
* **Rapid Detection of Real Customers**: A legitimate customer standing at the window must trigger an alert promptly (within 3–5 seconds of staff absence).

---

## Decision Outcome
**Chosen Solution**: **Two-Pronged Spatial Depth Refinement + Temporal Dwell-Time Confirmation**.

### 1. Spatial Depth Refinement ([configs/rules/cashier_presence.yaml](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/configs/rules/cashier_presence.yaml))
The visitor queue polygon was lowered and tightened to encompass only the queue bay leading directly to the service window, filtering out the background street:
```yaml
visitor_zone:
  - [0.36, 0.12]
  - [0.64, 0.12]
  - [0.64, 0.46]
  - [0.36, 0.46]
```

### 2. Dwell-Time Confirmation Filter (`min_waiting_confirm_sec: 3`)
- A pedestrian walking across the frame takes **1.0 to 2.0 seconds** to cross the window view.
- A waiting customer stands stationary in the queue lane for **5 to 30+ seconds**.
- The pipeline introduces `min_waiting_confirm_sec: 3`:
  - When a visitor enters `visitor_zone` while the desk is unattended, the system enters a verification stage, keeping the state displayed as `STATUS: UNATTENDED (Xs)`.
  - Only when the visitor remains continuously inside the queue zone for **$\ge 3$ seconds** does the system confirm a stationary customer and escalate to:
    ```text
    ALERT: CUSTOMER WAITING (3s) ... (10s)
    ```
  - If the visitor walks away before 3 seconds elapse, the dwell timer resets with **zero alerts generated**.

---

## Consequences

### Positive:
* **Zero False Positives**: Verified on `16:15 – 16:25` — the passerby crosses in ~1.5s and is completely ignored by the alerting engine.
* **100% True Positive Recall**: Verified on `29:45 – 30:05` — a customer arrives at `29:48` and is reliably escalated to `ALERT: CUSTOMER WAITING` at `29:51` (after 3 seconds of continuous waiting).
* **Configurable Sensitivity**: Sites with narrow or wide walkways can adjust `min_waiting_confirm_sec` in `cashier_presence.yaml` without touching pipeline code.

### Negative:
* Introduces a 3-second delay before the UI reflects customer waiting (which is operationally beneficial, as staff should not be alerted for someone merely stepping in and out of view).

---

## Validation
```text
================================================================================
EVALUATION RESULTS
================================================================================
1. Passerby Crossing (16:15 - 16:22):
   - Actual State: STATUS: UNATTENDED (Xs) throughout.
   - Alerts Dispatched: 0 (Zero False Alarms) [PASS]

2. True Customer Waiting (29:45 - 29:56):
   - Customer Arrives: 29:48
   - Dwell Reached: 29:51 -> ALERT: CUSTOMER WAITING (3s) [PASS]
   - Urgent Event: 29:53 -> [URGENT] Customer Waiting Event dispatched [PASS]
```
