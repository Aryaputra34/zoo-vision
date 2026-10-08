// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Base Device Agent Header

#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <map>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>
#include <condition_variable>

#include <nx/sdk/analytics/helpers/consuming_device_agent.h>
#include <nx/sdk/analytics/helpers/object_track_best_shot_packet.h>
#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/analytics/i_uncompressed_video_frame.h>

#include "tracker.h"
#include "yolo_detector.h"

namespace magnet {
namespace analytics {

/**
 * Nx-side state of one reported track.
 */
struct TrackRecord
{
    nx::sdk::Uuid uuid;
    int64_t firstReportedInference = 0;
    int64_t lastReportedInference = 0;
    bool bestShotSent = false;
};

/**
 * BaseDeviceAgent: Handles zero-copy YUV420 frame buffering, 5 FPS rate throttling,
 * YOLO inference, object tracking (ByteTrack/IoU), persistent UUID management, Best Shots,
 * and background worker threading.
 */
class BaseDeviceAgent: public nx::sdk::analytics::ConsumingDeviceAgent
{
public:
    static const std::string kByteTrackSetting;

    BaseDeviceAgent(
        const nx::sdk::IDeviceInfo* deviceInfo,
        std::shared_ptr<YoloDetector> detector);
    virtual ~BaseDeviceAgent() override;

protected:
    // Nx SDK overrides
    virtual bool pushUncompressedVideoFrame(
        nx::sdk::Ptr<const nx::sdk::analytics::IUncompressedVideoFrame> videoFrame) override;

    virtual bool pushCompressedVideoFrame(
        nx::sdk::Ptr<const nx::sdk::analytics::ICompressedVideoPacket> videoFrame) override;

    virtual bool pullMetadataPackets(
        std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>* metadataPackets) override;

    // Subclass customization points
    virtual std::string mapClassToObjectType(int classId, const Detection& det) const = 0;

    virtual std::vector<Detection> filterReportableDetections(
        const std::vector<Detection>& detections) const;

    /**
     * Domain event processing hook called on the worker thread for every inference pass.
     * Subclasses inspect tracked objects, evaluate dwell/zones, and append event packets to outPackets.
     */
    virtual void processTracks(
        const std::vector<TrackedDetection>& tracked,
        int64_t timestampUs,
        std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>& outPackets) {}

    // Helper to construct an EventMetadataPacket
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> createEventPacket(
        const std::string& eventTypeId,
        const std::string& caption,
        const std::string& description,
        int64_t timestampUs);

    void setByteTrackRequested(bool requested) { m_byteTrackRequested = requested; }

private:
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateObjectMetadataPacket(
        const std::vector<TrackedDetection>& tracked,
        const std::vector<nx::sdk::Uuid>& uuids,
        int64_t timestampUs);

    void ensureRequestedTracker();
    std::vector<nx::sdk::Uuid> updateTrackRecords(const std::vector<TrackedDetection>& tracked);
    std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>> collectBestShotPackets(
        const std::vector<TrackedDetection>& tracked,
        const std::vector<nx::sdk::Uuid>& uuids,
        int64_t timestampUs);

    void recordPassAndMaybeLogStats(int64_t inferenceUs, size_t bestShotCount);
    void workerLoop();

protected:
    std::string m_deviceId;
    int64_t m_lastVideoFrameTimestampUs = 0;
    int64_t m_eventCount = 0;

private:
    std::shared_ptr<YoloDetector> m_detector;

    int64_t m_frameIndex = 0;
    int64_t m_lastInferenceTimestampUs = 0;

    std::atomic<int64_t> m_droppedFrameCount{0};
    std::atomic<bool> m_byteTrackRequested{true}; // Default true for ByteTrack

    static constexpr int64_t kInferenceIntervalUs = 200000; // 5 FPS throttle
    static constexpr int64_t kTrackExpiryInferences = 10;   // ~2s at 5 FPS
    static constexpr int64_t kBestShotDelayInferences = 3;  // ~0.6s
    static constexpr float kIoUMatchThreshold = 0.3f;
    static constexpr float kIoUTrackerMinConfidence = 0.25f;

    std::unique_ptr<Tracker> m_tracker;
    bool m_trackerIsByteTrack = false;
    std::map<int64_t, TrackRecord> m_trackRecords;
    int64_t m_inferenceIndex = 0;

    struct StatsWindow
    {
        std::chrono::steady_clock::time_point start;
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

    std::thread m_workerThread;
    std::atomic<bool> m_terminated{false};
    std::atomic<bool> m_hasNewFrame{false};
    std::mutex m_frameMutex;
    std::condition_variable m_frameCv;
    nx::sdk::Ptr<const nx::sdk::analytics::IUncompressedVideoFrame> m_pendingFrame;

    std::mutex m_resultsMutex;
    std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>> m_pendingResults;
};

} // namespace analytics
} // namespace magnet
