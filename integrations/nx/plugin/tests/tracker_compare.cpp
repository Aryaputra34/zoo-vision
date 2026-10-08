// Copyright 2026 Magnet. All rights reserved.
// Runs IouTracker and ByteTrackTracker side by side on synthetic scenes and prints, for each, how
// many distinct track ids it produced and how many object reports it made. No Nx SDK or ONNX
// Runtime needed. Build and run from magnet_nx_plugin/ on the Linux server (one command):
//
//   g++ -std=c++17 -O2 -I src -I /usr/include/eigen3 tests/tracker_compare.cpp
//       src/iou_tracker.cpp src/byte_track_tracker.cpp src/third_party/bytetrack/*.cpp
//       -o /tmp/tracker_compare && /tmp/tracker_compare

#include <chrono>
#include <cstdio>
#include <memory>
#include <set>
#include <vector>

#include "byte_track_tracker.h"
#include "iou_tracker.h"

using namespace magnet::analytics;

namespace {

constexpr int kWidth = 1280;
constexpr int kHeight = 720;

// Same values DeviceAgent uses.
constexpr float kIouMinConfidence = 0.25f;
constexpr float kIouMatchThreshold = 0.3f;
constexpr int kExpiryPasses = 10;

Detection box(float px, float py, float pw, float ph, int classId, float confidence)
{
    Detection d;
    d.x = px / kWidth;
    d.y = py / kHeight;
    d.width = pw / kWidth;
    d.height = ph / kHeight;
    d.classId = classId;
    d.confidence = confidence;
    return d;
}

std::unique_ptr<Tracker> makeIou()
{
    return std::make_unique<IouTracker>(kIouMinConfidence, kIouMatchThreshold, kExpiryPasses);
}

std::unique_ptr<Tracker> makeByteTrack()
{
    ByteTrackTracker::Params params;
    params.lostPasses = kExpiryPasses;
    return std::make_unique<ByteTrackTracker>(params);
}

struct Outcome
{
    size_t ids = 0;
    long reports = 0;
};

template<typename FrameAt>
Outcome run(Tracker& tracker, int passes, FrameAt frameAt)
{
    std::set<int64_t> ids;
    long reports = 0;
    for (int pass = 0; pass < passes; ++pass)
    {
        for (const auto& tracked: tracker.update(frameAt(pass), kWidth, kHeight))
        {
            ids.insert(tracked.trackKey);
            ++reports;
        }
    }
    return {ids.size(), reports};
}

template<typename FrameAt>
void scenario(const char* name, const char* ideal, int passes, FrameAt frameAt)
{
    const auto iou = makeIou();
    const auto byteTrack = makeByteTrack();
    const Outcome a = run(*iou, passes, frameAt);
    const Outcome b = run(*byteTrack, passes, frameAt);
    std::printf("%-46s ideal: %-18s | iou: ids=%-3zu reports=%-4ld | bytetrack: ids=%-3zu reports=%ld\n",
        name, ideal, a.ids, a.reports, b.ids, b.reports);
}

} // namespace

int main()
{
    // 1. Speed sweep: one car (box 120 px wide) crossing at N px per pass. Consecutive-pass IoU is
    //    (120 - N) / (120 + N). Shows where each tracker stops holding one id.
    for (const int step: {20, 40, 55, 60, 65, 70, 90})
    {
        char name[64];
        std::snprintf(name, sizeof(name), "car w=120 at %d px/pass (IoU %.2f)",
            step, (120.0 - step) / (120.0 + step));
        scenario(name, "1 id, 17 reports", 17, [step](int p) {
            return std::vector<Detection>{box(10.0f + step * p, 300, 120, 80, 2, 0.8f)};
        });
    }

    // 2. Stationary horse whose confidence dips to 0.18 every 4th pass.
    scenario("stationary horse, conf 0.18 every 4th pass", "1 id, 40 reports", 40, [](int p) {
        return std::vector<Detection>{box(500, 300, 150, 150, 17, (p % 4 == 3) ? 0.18f : 0.8f)};
    });

    // 3. One real person plus a one-pass false positive (conf 0.4) in a new place every pass.
    scenario("person + 1-pass false positive per pass", "1 id, 40 reports", 40, [](int p) {
        return std::vector<Detection>{
            box(300, 300, 80, 200, 0, 0.8f),
            box(float(100 + (p * 97) % 1000), float(50 + (p * 53) % 500), 60, 60, 0, 0.4f)};
    });

    // 4. Horse (class 17) and rider (class 0) with nearly identical boxes: must stay separate.
    scenario("horse + rider overlapping (2 classes)", "2 ids, 60 reports", 30, [](int p) {
        return std::vector<Detection>{
            box(400.0f + 10 * p, 300, 160, 160, 17, 0.8f),
            box(410.0f + 10 * p, 280, 150, 170, 0, 0.8f)};
    });

    // 5. Horse occluded (no detection at all) for 6 passes, shorter than the expiry window.
    scenario("horse occluded for 6 passes", "1 id, 34 reports", 40, [](int p) {
        if (p >= 15 && p < 21)
            return std::vector<Detection>{};
        return std::vector<Detection>{box(300.0f + 8 * p, 300, 150, 150, 17, 0.8f)};
    });

    // 6. Soak: 5 objects cycling through the scene for 60k passes. Per-update cost must stay flat;
    //    upstream ByteTrack kept every removed track forever (see third_party/bytetrack/README.md).
    {
        const auto byteTrack = makeByteTrack();
        const auto frameAt = [](int p) {
            std::vector<Detection> v;
            for (int c = 0; c < 5; ++c)
            {
                const int phase = (p + c * 9) % 40;
                v.push_back(box(20.0f + 25.0f * phase, 60.0f + 120.0f * c, 100, 80, 2, 0.8f));
            }
            return v;
        };
        const auto usPerUpdate = [&](int from, int to) {
            const auto start = std::chrono::steady_clock::now();
            for (int p = from; p < to; ++p)
                byteTrack->update(frameAt(p), kWidth, kHeight);
            return std::chrono::duration<double, std::micro>(
                std::chrono::steady_clock::now() - start).count() / (to - from);
        };
        const double early = usPerUpdate(0, 2000);
        usPerUpdate(2000, 58000);
        const double late = usPerUpdate(58000, 60000);
        std::printf("bytetrack soak, 60k passes: %.1f us/update in the first 2k, %.1f in the last 2k"
            " (should be about equal)\n", early, late);
    }

    return 0;
}
