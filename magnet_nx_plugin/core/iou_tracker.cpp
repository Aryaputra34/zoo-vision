// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Greedy IoU Tracker Implementation

#include "iou_tracker.h"

#include <algorithm>

namespace magnet {
namespace analytics {

/**
 * Calculate IoU between a tracked object and a new detection for matching.
 */
static float computeIoU(const Detection& a, const Detection& b)
{
    const float x1 = std::max(a.x, b.x);
    const float y1 = std::max(a.y, b.y);
    const float x2 = std::min(a.x + a.width, b.x + b.width);
    const float y2 = std::min(a.y + a.height, b.y + b.height);

    const float interW = std::max(0.0f, x2 - x1);
    const float interH = std::max(0.0f, y2 - y1);
    const float intersection = interW * interH;

    const float areaA = a.width * a.height;
    const float areaB = b.width * b.height;
    const float unionArea = areaA + areaB - intersection;

    return (unionArea <= 0.0f) ? 0.0f : (intersection / unionArea);
}

IouTracker::IouTracker(float minConfidence, float iouMatchThreshold, int64_t expiryPasses):
    m_minConfidence(minConfidence),
    m_iouMatchThreshold(iouMatchThreshold),
    m_expiryPasses(expiryPasses)
{
}

std::vector<TrackedDetection> IouTracker::update(
    const std::vector<Detection>& allDetections, int /*frameWidth*/, int /*frameHeight*/)
{
    ++m_pass;

    std::vector<Detection> detections;
    for (const auto& det: allDetections)
    {
        if (det.confidence >= m_minConfidence)
            detections.push_back(det);
    }

    // Index of the track each detection belongs to.
    std::vector<int> trackForDetection(detections.size(), -1);
    std::vector<bool> trackMatched(m_tracks.size(), false);

    // 1. Greedy IoU matching: for each detection, find the best matching track of the same class
    for (size_t di = 0; di < detections.size(); ++di)
    {
        float bestIoU = m_iouMatchThreshold;
        int bestTrack = -1;

        for (size_t ti = 0; ti < m_tracks.size(); ++ti)
        {
            if (trackMatched[ti])
                continue;

            // Only match objects of the same class type
            if (m_tracks[ti].lastDetection.classId != detections[di].classId)
                continue;

            const float iou = computeIoU(m_tracks[ti].lastDetection, detections[di]);
            if (iou > bestIoU)
            {
                bestIoU = iou;
                bestTrack = static_cast<int>(ti);
            }
        }

        if (bestTrack >= 0)
        {
            // Update existing track with new detection position
            m_tracks[bestTrack].lastDetection = detections[di];
            m_tracks[bestTrack].lastSeenPass = m_pass;
            trackMatched[bestTrack] = true;
            trackForDetection[di] = bestTrack;
        }
    }

    // 2. Create new tracks for unmatched detections
    for (size_t di = 0; di < detections.size(); ++di)
    {
        if (trackForDetection[di] >= 0)
            continue;

        Track newTrack;
        newTrack.key = m_nextKey++;
        newTrack.lastDetection = detections[di];
        newTrack.lastSeenPass = m_pass;
        m_tracks.push_back(newTrack);
        trackForDetection[di] = static_cast<int>(m_tracks.size()) - 1;
    }

    // 3. Every detection now has a track; report them BEFORE expiry below invalidates the indices.
    std::vector<TrackedDetection> result;
    result.reserve(detections.size());
    for (size_t di = 0; di < detections.size(); ++di)
    {
        TrackedDetection tracked;
        tracked.trackKey = m_tracks[trackForDetection[di]].key;
        tracked.detection = detections[di];
        result.push_back(tracked);
    }

    // 4. Remove stale tracks that haven't been seen for too long
    m_tracks.erase(
        std::remove_if(m_tracks.begin(), m_tracks.end(),
            [this](const Track& t) { return (m_pass - t.lastSeenPass) > m_expiryPasses; }),
        m_tracks.end());

    return result;
}

} // namespace analytics
} // namespace magnet
