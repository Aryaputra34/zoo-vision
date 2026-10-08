// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Greedy IoU Tracker

#pragma once

#include <cstdint>
#include <vector>

#include "tracker.h"

namespace magnet {
namespace analytics {

/**
 * The plugin's original tracker: each detection is greedily matched to the unmatched same-class
 * track whose last box overlaps it most, with no motion prediction. Cheap and adequate for slow
 * objects at a high pass rate; it loses identity once an object moves more than about half its
 * own width between passes (see docs/06 Phase 3A).
 */
class IouTracker: public Tracker
{
public:
    /**
     * @param minConfidence Detections below this are ignored. The detector's floor is lower so
     *     that ByteTrack's second association has low-confidence boxes to work with.
     * @param iouMatchThreshold Minimum IoU for a detection to continue a track.
     * @param expiryPasses A track unmatched for more than this many passes is dropped.
     */
    IouTracker(float minConfidence, float iouMatchThreshold, int64_t expiryPasses);

    virtual const char* name() const override { return "iou"; }

    virtual std::vector<TrackedDetection> update(
        const std::vector<Detection>& detections, int frameWidth, int frameHeight) override;

private:
    struct Track
    {
        int64_t key = 0;
        Detection lastDetection;
        int64_t lastSeenPass = 0;
    };

    const float m_minConfidence;
    const float m_iouMatchThreshold;
    const int64_t m_expiryPasses;

    std::vector<Track> m_tracks;
    int64_t m_pass = 0;
    int64_t m_nextKey = 1;
};

} // namespace analytics
} // namespace magnet
