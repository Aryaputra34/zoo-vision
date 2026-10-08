// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - ByteTrack Tracker

#pragma once

#include <map>
#include <memory>
#include <vector>

#include "tracker.h"

namespace bytetrack { class BYTETracker; }

namespace magnet {
namespace analytics {

/**
 * ByteTrack behind the Tracker interface, using the vendored reference implementation in
 * src/third_party/bytetrack (see its README for local changes). Compared with IouTracker it adds
 * Kalman motion prediction, globally optimal assignment, a second association pass in which
 * low-confidence detections keep existing tracks alive, and a two-pass confirmation before a new
 * track is reported. It is the same algorithm the Python pipelines run through supervision.
 */
class ByteTrackTracker: public Tracker
{
public:
    /** Defaults mirror the Python horse and gate pipelines (horse_riding.yaml, vehicle_gate.yaml). */
    struct Params
    {
        /// Detections at or above this take part in the first association. Those below it are
        /// used only in the second, where they can extend an existing track but never start one.
        /// Python: track_activation_thresh.
        float trackThresh = 0.25f;

        /// Minimum confidence for an unmatched detection to start a new, unconfirmed track.
        /// supervision derives it as track_activation_thresh + 0.1.
        float highThresh = 0.35f;

        /// First-association cost threshold, expressed as 1 - IoU: 0.7 accepts IoU >= 0.3.
        /// Python: matching_thresh.
        float matchThresh = 0.7f;

        /// Inference passes a lost track is kept for re-identification before it is dropped.
        int lostPasses = 10;
    };

    explicit ByteTrackTracker(const Params& params);
    virtual ~ByteTrackTracker() override;

    virtual const char* name() const override { return "bytetrack"; }

    virtual std::vector<TrackedDetection> update(
        const std::vector<Detection>& detections, int frameWidth, int frameHeight) override;

private:
    const Params m_params;

    /// One tracker per class. The reference matches boxes regardless of class, so a shared
    /// instance would let a person's detection continue a horse's track.
    std::map<int, std::unique_ptr<bytetrack::BYTETracker>> m_trackersByClass;
};

} // namespace analytics
} // namespace magnet
