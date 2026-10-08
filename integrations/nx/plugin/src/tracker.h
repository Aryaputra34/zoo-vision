// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Object Tracker Interface

#pragma once

#include <cstdint>
#include <vector>

#include "detection.h"

namespace magnet {
namespace analytics {

/** A track confirmed in the current pass, as reported by a Tracker. */
struct TrackedDetection
{
    /// Identifies the track within the Tracker instance that reported it. Stable for as long as
    /// that tracker keeps the track, and never reused by it.
    int64_t trackKey = 0;

    /// Normalized box, class and confidence describing the object in THIS pass's frame.
    Detection detection;
};

/**
 * Assigns persistent identities to per-frame detections. An instance is created, updated and
 * destroyed on the inference worker thread only.
 */
class Tracker
{
public:
    virtual ~Tracker() = default;

    /** Short name for logs and the stats line, e.g. "iou" or "bytetrack". */
    virtual const char* name() const = 0;

    /**
     * Advances the tracker by one inference pass.
     *
     * @param detections Every detection of this pass: normalized, restricted to classes the plugin
     *     reports, non-degenerate. Includes low-confidence detections (down to the detector's
     *     floor); each tracker applies its own confidence policy.
     * @param frameWidth, frameHeight Size in pixels of the frame the detections came from.
     * @return Tracks matched or created in this pass, i.e. exactly the ones to report for it.
     */
    virtual std::vector<TrackedDetection> update(
        const std::vector<Detection>& detections, int frameWidth, int frameHeight) = 0;
};

} // namespace analytics
} // namespace magnet
