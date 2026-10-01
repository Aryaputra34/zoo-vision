# ADR-007: Vendored ByteTrack with a Per-Camera Tracker Toggle

* **Status**: Accepted (on-server verification pending)
* **Date**: 2026-09-30
* **Deciders**: Computer Vision Engineering Team
* **Technical Domain**: Magnet Nx MetaVMS C++ Plugin, Object Tracking (docs/06 Phase 3A tasks 3–4)

---

## Context and Problem Statement

The plugin tracked objects with a greedy IoU matcher. It has no motion prediction, no rescue of
low-confidence detections, and it publishes a track on its first detection (see
[`iou_tracker.cpp`](../../magnet_nx_plugin/src/iou_tracker.cpp)). The Python pipelines track with
`supervision`'s ByteTrack at 12–15 FPS on GPU, and add Kalman prediction, globally optimal
assignment, a low-confidence second association, and a two-frame confirmation of new tracks.

docs/06 Phase 3A carries a decision point: *if better matching amounts to reimplementing ByteTrack
in C++, stop and reconsider.* Tasks 3 and 4 (prediction, better assignment, confirmation) are
exactly ByteTrack.

## Decision

1. **Vendor the ByteTrack reference C++ tracker; do not hand-roll one.** The source is
   `ifzhang/ByteTrack` `deploy/TensorRT/cpp` (MIT), placed in
   [`src/third_party/bytetrack/`](../../magnet_nx_plugin/src/third_party/bytetrack/README.md).
   * It is the algorithm the Python pipelines already run, so their tuning carries over.
   * The hard parts are proven: Kalman, two-stage association, and lost-track re-identification.
   * The new dependency is Eigen (header-only, `libeigen3-dev`, installed by
     `build_on_server.sh`).
2. **Patch the reference minimally, and only for safety inside a 24/7 mediaserver.** Every change
   is listed in the vendored README and marked `// Magnet:` in the source:
   * removed `exit()` calls, which would kill the mediaserver;
   * removed an unbounded `removed_stracks` list;
   * made the track-ID counter atomic, because each camera tracks on its own thread;
   * dropped the OpenCV types;
   * made the thresholds parameters;
   * added a namespace.
3. **Put both trackers behind a small `Tracker` interface**
   ([`tracker.h`](../../magnet_nx_plugin/src/tracker.h)).
   * `DeviceAgent` owns the Nx side: track UUIDs, the Best Shot state, and the stats, all in a
     `TrackRecord` keyed by the tracker's key. That side is identical for both trackers.
   * `ByteTrackTracker` runs one ByteTrack per class, because the reference ignores class. It
     works in pixels, because the reference IoU adds +1 per extent.
4. **Make the tracker a per-camera setting.** "ByteTrack tracking" is a `SwitchButton` in the
   Engine's `deviceAgentSettingsModel`, shown in Camera Settings → Plugins, **default off**.
   * `settingsReceived()` only sets an atomic flag. The worker swaps trackers at the start of its
     next pass and clears all track records, so objects in view get new Nx tracks once.
   * The stats line prints `tracker=iou|bytetrack`, so both can be compared on the same clip.
5. **Thresholds mirror the Python horse and gate rules.**

   | Plugin parameter | Value | Python rule / supervision equivalent |
   | :--- | :--- | :--- |
   | `trackThresh` | 0.25 | `track_activation_thresh` |
   | `highThresh` | 0.35 | activation + 0.1 |
   | `matchThresh` | 0.7 | `matching_thresh`, i.e. IoU ≥ 0.3 |

   * `lostPasses` = `kTrackExpiryInferences` (10), the same lifetime as IoU tracks. This keeps
     `tracks_created` and `tracks_expired` comparable between the two trackers.
   * One known difference: the C++ reference does not multiply IoU by score in the first
     association. supervision does, so the plugin matches slightly more permissively.
6. **The detector's confidence floor drops from 0.25 to 0.1**
   ([`engine.cpp`](../../magnet_nx_plugin/src/engine.cpp)). ByteTrack's second association needs
   the 0.1–0.25 band.
   * The IoU tracker filters below 0.25 itself.
   * NMS is class-aware and runs highest-confidence first, so the set of detections ≥ 0.25 is
     unchanged. IoU-mode behavior is identical to before.

## Known Limitation: Fast Motion at Low Pass Rates

A new ByteTrack track is confirmed only if its first box overlaps the next detection (IoU ≳ 0.3).
Kalman velocity is still zero at that point, so the prediction can't help. An object that moves
more than about half its width per pass is reported **once**, on the tracker's first frame, and
never confirmed after that.

We simulated this with supervision's ByteTrack. A 120 px car holds one ID at ≤ 40 px per pass,
but is reported once in 17 passes at 55 px or more. The C++ reference, without score fusion,
should hold to about 65 px.

The IoU tracker still shows such an object on every pass, with a new ID each time. So:
* **ByteTrack** suits slow scenes: horse riding, the vehicle gate, people. It adds occlusion
  handling, rescue through confidence dips, and suppression of one-pass false positives.
* **IoU** remains the better choice for fast cross-traffic at a low pass rate.

The per-camera toggle is what makes this a per-scene choice. The limitation shrinks as the pass
rate rises, i.e. on production hardware or a GPU.

## Verification

* **Local, done:**
  * All plugin and vendored sources compile with `-Wall -Wextra` against SDK 6.1.2 and Eigen
    3.4.
  * The comparison harness [`tests/tracker_compare.cpp`](../../magnet_nx_plugin/tests/tracker_compare.cpp)
    compiles and links.
  * Running it locally is blocked: antivirus quarantines the fresh binary.
* **Pending, on the server:**
  1. Run `tests/tracker_compare` and check the speed sweep, confidence-dip, false-positive,
     two-class, occlusion and 60k-pass soak results.
  2. Enable the switch on one camera and confirm the `tracker=bytetrack` log line.
  3. Run the horse and gate clips with each tracker and compare `tracks_created` against the real
     object count.
