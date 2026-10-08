// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - ByteTrack Tracker Implementation

#include "byte_track_tracker.h"

#include <algorithm>

#include "third_party/bytetrack/BYTETracker.h"

namespace magnet {
namespace analytics {

namespace {

/// Same degenerate-box cut-off the DeviceAgent applies before tracking, in normalized units.
constexpr float kMinNormalizedExtent = 0.001f;

} // namespace

ByteTrackTracker::ByteTrackTracker(const Params& params):
    m_params(params)
{
}

// Out of line so std::unique_ptr sees the complete bytetrack::BYTETracker.
ByteTrackTracker::~ByteTrackTracker() = default;

std::vector<TrackedDetection> ByteTrackTracker::update(
    const std::vector<Detection>& detections, int frameWidth, int frameHeight)
{
    if (frameWidth <= 0 || frameHeight <= 0)
        return {};

    const float w = static_cast<float>(frameWidth);
    const float h = static_cast<float>(frameHeight);

    // ByteTrack works in pixels (see bytetrack::Rect), so scale up here and back down below.
    std::map<int, std::vector<bytetrack::Object>> objectsByClass;
    for (const auto& det: detections)
    {
        bytetrack::Object object;
        object.rect = {det.x * w, det.y * h, det.width * w, det.height * h};
        object.label = det.classId;
        object.prob = det.confidence;
        objectsByClass[det.classId].push_back(object);
    }

    for (const auto& entry: objectsByClass)
    {
        auto& tracker = m_trackersByClass[entry.first];
        if (!tracker)
        {
            // frame_rate = 30 makes track_buffer count update() calls directly, i.e. passes.
            tracker = std::make_unique<bytetrack::BYTETracker>(
                /*frame_rate*/ 30,
                /*track_buffer*/ m_params.lostPasses,
                m_params.trackThresh,
                m_params.highThresh,
                m_params.matchThresh);
        }
    }

    static const std::vector<bytetrack::Object> kNoObjects;

    std::vector<TrackedDetection> result;

    // Advance EVERY class's tracker every pass, including with no detections: that is how its
    // tracks age into "lost" and eventually expire.
    for (auto& entry: m_trackersByClass)
    {
        const int classId = entry.first;
        const auto found = objectsByClass.find(classId);
        const auto& objects = (found != objectsByClass.end()) ? found->second : kNoObjects;

        // Only tracks confirmed and matched in this update come back.
        for (const auto& track: entry.second->update(objects))
        {
            // tlwh is the Kalman-filtered box, which can overhang the frame; clamp it.
            const float x0 = std::max(0.0f, track.tlwh[0]) / w;
            const float y0 = std::max(0.0f, track.tlwh[1]) / h;
            const float x1 = std::min(w, track.tlwh[0] + track.tlwh[2]) / w;
            const float y1 = std::min(h, track.tlwh[1] + track.tlwh[3]) / h;

            if (x1 - x0 <= kMinNormalizedExtent || y1 - y0 <= kMinNormalizedExtent)
                continue;

            TrackedDetection tracked;
            // track_id is unique only within a class's tracker in principle, so fold the class in.
            tracked.trackKey = (static_cast<int64_t>(classId) << 32)
                | static_cast<int64_t>(static_cast<uint32_t>(track.track_id));
            tracked.detection.x = x0;
            tracked.detection.y = y0;
            tracked.detection.width = x1 - x0;
            tracked.detection.height = y1 - y0;
            tracked.detection.classId = classId;
            tracked.detection.confidence = track.score;
            result.push_back(tracked);
        }
    }

    return result;
}

} // namespace analytics
} // namespace magnet
