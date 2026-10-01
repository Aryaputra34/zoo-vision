// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Device Agent Header

#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <map>

#include <nx/sdk/analytics/helpers/consuming_device_agent.h>
#include <nx/sdk/analytics/helpers/object_track_best_shot_packet.h>
#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/analytics/i_uncompressed_video_frame.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>
#include <condition_variable>
#include "tracker.h"
#include "yolo_detector.h"

namespace magnet {
namespace analytics {

/**
 * Nx-side state of one reported track, keyed by Tracker::trackKey: the persistent Nx track UUID
 * that lets the Nx Meta Client display continuous bounding box overlays, and the Best Shot state.
 * Independent of which Tracker produced the track.
 */
struct TrackRecord
{
    nx::sdk::Uuid uuid;

    /// Value of m_inferenceIndex when this track was first reported. Best Shots are withheld until
    /// the Server has had a few passes to register the track (see kBestShotDelayInferences).
    int64_t firstReportedInference = 0;

    /// Value of m_inferenceIndex when this track was last reported. Counted in inference passes,
    /// NOT pushed frames, because tracking only advances when inference runs.
    int64_t lastReportedInference = 0;

    bool bestShotSent = false;  ///< Whether a best shot packet has been sent for this track
};

class DeviceAgent: public nx::sdk::analytics::ConsumingDeviceAgent
{
public:
    /// Device Agent setting (a SwitchButton declared in Engine::manifestString()): when true, track
    /// with ByteTrack instead of the greedy IoU tracker.
    static const std::string kByteTrackSetting;

    DeviceAgent(
        const nx::sdk::IDeviceInfo* deviceInfo,
        std::shared_ptr<YoloDetector> detector = nullptr);
    virtual ~DeviceAgent() override;

protected:
    virtual std::string manifestString() const override;

    virtual nx::sdk::Result<const nx::sdk::ISettingsResponse*> settingsReceived() override;

    virtual bool pushUncompressedVideoFrame(
        nx::sdk::Ptr<const nx::sdk::analytics::IUncompressedVideoFrame> videoFrame) override;

    virtual bool pushCompressedVideoFrame(
        nx::sdk::Ptr<const nx::sdk::analytics::ICompressedVideoPacket> videoFrame) override;

    virtual bool pullMetadataPackets(
        std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>* metadataPackets) override;

private:
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateObjectMetadataPacket(
        const std::vector<TrackedDetection>& tracked,
        const std::vector<nx::sdk::Uuid>& uuids,
        int64_t timestampUs);
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateEventMetadataPacket(
        const std::string& eventTypeId,
        const std::string& caption,
        const std::string& description);

    std::string mapClassToObjectType(int classId) const;

    /**
     * Keeps only detections the plugin can report: a class with an Nx object type, and a box that
     * is not degenerate. Applied before tracking, so no tracker can create a track the object
     * packet would then have to drop.
     */
    std::vector<Detection> filterReportableDetections(
        const std::vector<Detection>& detections) const;

    /**
     * Makes m_tracker the tracker the settings ask for. Switching discards every track: the new
     * tracker starts from scratch, so objects in view get a new Nx track once.
     */
    void ensureRequestedTracker();

    /**
     * Records this pass's reported tracks in m_trackRecords, minting an Nx Uuid for new ones, and
     * expires records whose track the tracker can no longer report.
     *
     * @return One Nx track Uuid per entry of `tracked`, positionally aligned with it.
     */
    std::vector<nx::sdk::Uuid> updateTrackRecords(const std::vector<TrackedDetection>& tracked);

    /**
     * Collects Best Shot packets for tracks that are ready for one. This tells the Nx Meta Server
     * to crop the frame at the given timestamp to the bounding box and use it as the thumbnail in
     * the right-side object panel.
     *
     * The caller MUST queue the object metadata packet for the current pass BEFORE these packets:
     * the Server silently discards a Best Shot for a track it has not registered yet.
     */
    std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>> collectBestShotPackets(
        const std::vector<TrackedDetection>& tracked,
        const std::vector<nx::sdk::Uuid>& uuids,
        int64_t timestampUs);

    /**
     * Adds one inference pass to the current stats window and, once kStatsInterval has elapsed,
     * prints a single "[Magnet AI Stats]" line to stdout and starts a new window. This is the
     * Phase 3A measurement: the real inference rate against kInferenceIntervalUs, and track churn
     * against the number of objects actually in the scene.
     */
    void recordPassAndMaybeLogStats(int64_t inferenceUs, size_t bestShotCount);

private:
    void workerLoop();

private:
    // Object Type IDs
    static const std::string kCashierObjectType;
    static const std::string kVisitorObjectType;
    static const std::string kVehicleObjectType;
    static const std::string kPlateObjectType;
    static const std::string kHorseObjectType;

    // Event Type IDs
    static const std::string kCashierUnattendedEventType;
    static const std::string kVisitorUnservedEventType;
    static const std::string kOccupancyExceededEventType;
    static const std::string kVehicleEntryEventType;
    static const std::string kHorseDepartureEventType;
    static const std::string kHorseReturnEventType;

private:
    std::shared_ptr<YoloDetector> m_detector;

    // Touched only on the Server's frame-push thread. Nothing on the worker thread may read
    // these, which is what keeps them safe without a mutex.
    int64_t m_frameIndex = 0;
    int64_t m_eventCount = 0;
    int64_t m_lastVideoFrameTimestampUs = 0;
    int64_t m_lastInferenceTimestampUs = 0;

    bool m_startupDiagnosticSent = false;

    /// Frames that passed the kInferenceIntervalUs throttle but never reached inference, almost
    /// always because a newer frame replaced them in the queue while the worker was busy. A rising
    /// count means the effective analytics frame rate is below what kInferenceIntervalUs implies,
    /// which is the leading cause of unstable IoU track matching. See ADR-006. Written on the
    /// frame-push thread but read by the worker for the stats log, hence atomic rather than in the
    /// group above.
    std::atomic<int64_t> m_droppedFrameCount{0};

    /// Tracker the settings ask for. Written by settingsReceived() on a Server thread, read by the
    /// worker at the start of each pass (see ensureRequestedTracker).
    std::atomic<bool> m_byteTrackRequested{false};

    static constexpr int64_t kInferenceIntervalUs = 200000; // 5 FPS throttle

    // Track lifetimes are counted in INFERENCE passes, not pushed frames. At 5 FPS inference on a
    // 25 FPS stream a frame-based budget is ~5x shorter than it reads, which expired tracks during
    // ordinary occlusions and collided with the Best Shot delay below.
    static constexpr int64_t kTrackExpiryInferences = 10;   // ~2s at 5 FPS
    static constexpr int64_t kBestShotDelayInferences = 3;  // ~0.6s for the Server to register it
    static constexpr float kIoUMatchThreshold = 0.3f;       // IoU threshold for track matching

    /// Confidence the IoU tracker requires. The detector's own floor is lower (see engine.cpp) so
    /// that ByteTrack's second association has low-confidence detections to work with.
    static constexpr float kIoUTrackerMinConfidence = 0.25f;
    std::string m_deviceId;

    // Tracking state. Worker-thread only: created, updated and read exclusively inside
    // workerLoop().
    std::unique_ptr<Tracker> m_tracker;
    bool m_trackerIsByteTrack = false;
    std::map<int64_t, TrackRecord> m_trackRecords;
    int64_t m_inferenceIndex = 0;

    /// Counters for the periodic stats log (see recordPassAndMaybeLogStats). Worker-thread only,
    /// under the same rule as m_trackRecords.
    struct StatsWindow
    {
        std::chrono::steady_clock::time_point start; ///< First pass, then each log line.
        int64_t passes = 0;
        int64_t inferenceUsTotal = 0;
        int64_t inferenceUsMax = 0;
        int64_t tracksCreated = 0;
        int64_t tracksExpired = 0;
        int64_t bestShotsSent = 0;
        int64_t droppedFramesAtStart = 0;
    };
    StatsWindow m_stats;
    static constexpr auto kStatsInterval = std::chrono::seconds(30);

    // Background worker thread for non-blocking AI inference
    std::thread m_workerThread;
    std::atomic<bool> m_terminated{false};
    std::atomic<bool> m_hasNewFrame{false};
    std::mutex m_frameMutex;
    std::condition_variable m_frameCv;
    nx::sdk::Ptr<const nx::sdk::analytics::IUncompressedVideoFrame> m_pendingFrame;

    // Results buffer: worker thread writes, pullMetadataPackets reads
    std::mutex m_resultsMutex;
    std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>> m_pendingResults;
};

} // namespace analytics
} // namespace magnet
