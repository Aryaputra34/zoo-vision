# Vendored: ByteTrack (C++ reference tracker)

* **Upstream**: https://github.com/ifzhang/ByteTrack, directory `deploy/TensorRT/cpp`
  (`include/` + `src/`, minus the `bytetrack.cpp` demo and `logging.h`).
* **Fetched**: 2026-09-30 from branch `main`.
* **License**: MIT. See `LICENSE` in this folder.
* **Why**: the Python pipelines track with `supervision`'s ByteTrack, a port of this same algorithm.
  Vendoring the reference keeps the plugin's tracker behaviour comparable with them, instead of
  hand-rolling Kalman prediction and two-stage association. See ADR-007.
* **Dependency**: Eigen 3 (header-only), installed on the build server as `libeigen3-dev`.

## Local modifications

Every change is marked in the source with a `// Magnet:` comment.

1. **No OpenCV.**
   * The `<opencv2/opencv.hpp>` include and `using namespace cv` are removed.
   * `cv::Rect_<float>` in `Object` is replaced by a plain `bytetrack::Rect`, still in pixels,
     because `ious()` adds 1 to every extent.
   * `get_color()`, which returned `cv::Scalar`, is removed.
2. **Namespace.** Everything is wrapped in `namespace bytetrack`. This keeps
   `using namespace std` and generic names (`Object`, `New`, `Lost`...) out of the plugin's global
   namespace.
3. **Configurable thresholds.** `BYTETracker`'s constructor now takes `track_thresh`,
   `high_thresh` and `match_thresh`, which were hardcoded to 0.5 / 0.6 / 0.8. The
   `Init ByteTrack!` stdout print is also removed.
4. **Thread-safe IDs.** `STrack::next_id()` uses `static std::atomic<int>`. Upstream used a plain
   `static int` shared by all trackers, and each camera's inference worker runs on its own thread.
5. **No unbounded growth.** The `removed_stracks` member is removed. Upstream appended every removed
   track to it forever, so memory and per-update cost grew for the life of the process.
6. **No `exit()` in the mediaserver.**
   * `lapjv()`'s error paths (`system("pause"); exit(0);`) now return "nothing matched".
   * Its raw `new[]` buffers are replaced with `std::vector`.
   * `KalmanFilter::gating_distance()` and `chi2inv95` are removed. They were unused, and one path
     called `exit(0)`.

The ByteTrack algorithm is otherwise untouched: Kalman filter, two-stage association, lapjv
assignment, and lost-track handling.

**One upstream difference from `supervision`, deliberately left as is:** this reference does not
multiply IoU by detection score in the first association. It therefore matches slightly more
permissively than the Python pipelines at the same `match_thresh`.
