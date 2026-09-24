# ADR-001: Multi-Camera Decoupled Pipeline and Inline ROI Architecture

* **Status**: Accepted
* **Date**: 2026-09-23
* **Deciders**: Computer Vision Engineering Team
* **Technical Domain**: Vision Pipeline Orchestration, Configuration Management

---

## Context and Problem Statement
In a theme park / zoo deployment with multiple ticket booths (e.g., Loket Mini Train, Loket Safari Journey, Gate 1 Cashier), each cashier station has a distinct camera mounting position, focal length, angle, and physical layout:
- Does each physical camera require a separate Python pipeline class or custom script to define its Region of Interest (ROI)?
- How do we manage dozens of camera feeds without code duplication or configuration sprawl across hundreds of separate YAML files?

---

## Decision Drivers
* **Code Reusability**: Prevent duplicating pipeline logic (YOLO inference, presence timers, alerting) across different cameras.
* **Operational Simplicity**: Allow field engineers to adjust or paste coordinates from `pick_coordinates.py` into a single configuration file without creating boilerplate files.
* **Per-Camera State Isolation**: Ensure each camera maintains its own independent presence clocks, debounce counters, and alarm states.
* **Backward Compatibility**: Existing camera setups pointing to external rule files (`rule_config: ...`) must continue to function without breaking.

---

## Considered Options
1. **Option A (Hardcoded Pipelines)**: Create a dedicated subclass/file per camera (e.g., `CashierBooth1Pipeline`, `CashierBooth2Pipeline`).
2. **Option B (Separate Rule File per Camera)**: Maintain one generic pipeline class, but require an individual YAML rule file per camera (e.g., `cashier_booth_1.yaml`, `cashier_booth_2.yaml`).
3. **Option C (Unified Class + Inline ROI in `cameras.yaml` with Base Fallback)**: Use a single generic pipeline class, instantiate one isolated object per camera at runtime, and allow camera-specific `roi` directly inline within [configs/cameras.yaml](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/configs/cameras.yaml) while inheriting defaults from a shared template.

---

## Decision Outcome
**Chosen Option**: **Option C (Unified Class + Inline ROI in `cameras.yaml`)**.

### Technical Details:
1. **Pipeline Class Reusability**: [pipelines/cashier_presence_pipeline.py](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/pipelines/cashier_presence_pipeline.py) remains a single generic, highly optimized class.
2. **Runtime Instance Isolation**: The orchestrator in [main.py](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/main.py) loops over `cameras.yaml` and instantiates a separate `CashierPresencePipeline` instance per camera. Each instance holds its own `PolygonZone`, `last_presence_time`, and state machine in memory.
3. **Hierarchy of Configuration**:
   - Level 1: Shared baseline configuration loaded from `rule_config: "configs/rules/cashier_presence.yaml"` (model choice, confidence thresholds, debounce intervals).
   - Level 2: Camera-specific `roi` polygon coordinates defined inline in `cameras.yaml`, overriding defaults:
     ```yaml
     cameras:
       - id: "cam_cashier_01"
         name: "Loket Mini Train Cashier"
         pipeline: "cashier_presence"
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
     ```
4. **Tooling Integration**: [pick_coordinates.py](file:///c:/Users/Magnet%20Busdev-2/Documents/temp/zoo-monitor/pick_coordinates.py) directly outputs pre-formatted `roi:` blocks ready for copy-pasting into `cameras.yaml`.

---

## Consequences

### Positive:
* **Zero Code Duplication**: 10+ cashier booths share the exact same battle-tested inference and alerting code.
* **Clean Configuration**: Global parameters (like alert debounce or confidence thresholds) are updated in one central YAML file, while unique camera geometries live in `cameras.yaml`.
* **Zero Overhead**: Adding a new cashier station only requires adding 15 lines of YAML to `cameras.yaml`.

### Negative:
* `cameras.yaml` file length increases with many cameras (mitigated by clean indentation and optional external rule file support).

---

## Validation
* Successfully instantiated multiple cameras simultaneously (`cam_cashier_01` and `cam_cashier_02`) with independent polygons and verified that zone triggers and states operate independently without cross-talk.
