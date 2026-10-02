# ADR-008: Python Analytics + MediaMTX + Web Dashboard; Nx Optional

* **Status**: Accepted
* **Date**: 2026-10-02
* **Deciders**: Computer Vision Engineering Team
* **Technical Domain**: System architecture, video ingest/recording, web dashboard (`zoo-analytics-web`)
* **Supersedes**: the plugin-first direction of [docs/06](../06_MAGNET_NX_PLUGIN_IMPLEMENTATION_PLAN.md) Phases 4–6

---

## Context and Problem Statement

We had two analytics paths:

* **Python service** (`main.py`, `pipelines/`). It covers all Phase 1–2 use cases (gate + ANPR,
  cashier, restaurant/tables, pony rides). It is also the only thing that feeds the web dashboard.
* **C++ Nx plugin** (`magnet_nx_plugin/`). It does detection, tracking and Best Shots only:
  * CPU only, with every camera serialized on one mutex.
  * No zones, rules or events.
  * No path to the dashboard.

  Phases 4–6 of docs/06 (port the rules, zones in Nx, packaging) were not started.

The question was: Nx plugin or Python services, given that we still need the web dashboard? And if
there is no Nx, who handles live video, snapshot history and recording?

Facts that decide it:

* **Scale.** A deployment is **about 12 cameras, depending on the use case**, not the 300-camera
  estate in docs/01 and docs/03.
* **The use cases are business analytics.** The evidence people need is a snapshot plus a short clip
  around each event, not hours of forensic footage.
* **Nx Best Shots are cropped from Nx's own archive.** If Nx only does live view (docs/01:60), they
  come out empty.

## Decision

1. **Python is the only analytics engine.** No business rules are ported to C++.
2. **MediaMTX** ([`configs/mediamtx.yml`](../../configs/mediamtx.yml), in `docker-compose.yml`)
   handles video. It pulls each camera once over TCP and:
   * records it with a retention window (`recordDeleteAfter`, default 7 days);
   * re-serves RTSP to the AI engine;
   * serves clips by time range from its playback server on `:9996`.
3. **The AI engine serves an HTTP API** ([`core/api_server.py`](../../core/api_server.py)):
   * `/health`;
   * `/frame/{camera}`;
   * `/stream/{camera}`: an annotated MJPEG preview, encoded only while someone watches;
   * `/snapshots/...`.
4. **Every non-status event carries evidence.** `BasePipeline.run()` saves the annotated frame as a
   JPEG ([`core/snapshot_store.py`](../../core/snapshot_store.py), with retention). It adds
   `snapshot` and `recordingPath` to the event data before the event is sent.
5. **The dashboard is the only UI.** It proxies the AI engine and MediaMTX behind a login
   (`DASHBOARD_PASSWORD`), so browsers never reach `:8000` or `:9996`. It adds:
   * a `/live` page;
   * a **Bukti** (evidence) column with the snapshot and a "play clip" on the event tables;
   * restaurant table occupancy.
6. **`main.py` runs one worker thread per camera** instead of one sequential loop. A failing camera
   is logged and skipped, and the others keep running.
7. **Nx is optional.**
   * `magnet_nx_plugin/` and `nx_integration/` stay in the repo, frozen.
   * Nx REST bookmarks still work when `nx_server.mock_mode: false`.
   * Use Nx only at a site that already runs it **and** records these cameras on it.

## Consequences

* **Positive**
  * One codebase for the rules.
  * One UI for the customer.
  * No Nx licence.
  * Nothing of ours runs inside a VMS process, so an AI crash or redeploy never stops recording.
* **Negative**
  * No scrubbable multi-camera timeline, PTZ or VMS failover. These are out of scope for business
    analytics; a site that needs them should keep its NVR or Nx for security.
  * We now own the disk sizing for recordings: ~43 GB/day per 4 Mbit/s camera.
  * Clips play only if cameras stream H.264, because browsers don't reliably play H.265.
* **Operational**
  * Event timestamps and recordings must share a clock: run NTP on the AI box, the MediaMTX host and
    the cameras.
  * Clips can't be range-requested (MediaMTX returns the whole file), so 30 s clips are downloaded
    in full before seeking.

## Verification (2026-10-02, dev workstation, CPU)

* **Recording and clips.** MediaMTX v1.21.1 with this config recorded a looped test feed. A 30 s
  clip was requested through the dashboard for a real `horse_crossing` event. It came back as
  H.264 MP4 with the `moov` atom first, and the frame at +15 s shows the pony at the tripwire,
  matching the snapshot.
* **Parallel workers.** Two cameras ran in parallel at ~5 and ~6 FPS (`yolo11n`).
* **API.** The API refused requests without its key. The MJPEG upstream closed when the viewer
  closed.
* **Shutdown.** SIGINT stopped every worker, stream and the API cleanly.
* **Dashboard.** Login and redirect worked, and the APIs returned 401 without a session. Ingest
  stayed open to the bearer key. Snapshots, the live grid and the table section rendered with no
  console errors.
