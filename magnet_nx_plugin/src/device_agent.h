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

#include <memory>
#include <mutex>
#include <thread>
#include <atomic>
#include <condition_variable>
#include "yolo_detector.h"

namespace magnet {
namespace analytics {

/**
 * Tracked object state: maintains a persistent Nx track UUID for an object
 * across consecutive frames, enabling the Nx Meta Client to display continuous
 * bounding box overlays.
 */
struct TrackedObject
{
    nx::sdk::Uuid trackId;
    Detection lastDetection;

    /// Value of m_inferenceIndex when this track was created. Best Shots are withheld until the
    /// Server has had a few passes to register the track (see kBestShotDelayInferences).
    int64_t firstSeenInference = 0;

    /// Value of m_inferenceIndex when this track was last matched to a detection. Counted in
    /// inference passes, NOT pushed frames, because tracking only advances when inference runs.
    int64_t lastSeenInference = 0;

    bool bestShotSent = false;  ///< Whether a best shot packet has been sent for this track
};

class DeviceAgent: public nx::sdk::analytics::ConsumingDeviceAgent
{
public:
    DeviceAgent(
        const nx::sdk::IDeviceInfo* deviceInfo,
        std::shared_ptr<YoloDetector> detector = nullptr);
    virtual ~DeviceAgent() override;

protected:
    virtual std::string manifestString() const override;

    virtual bool pushUncompressedVideoFrame(
        nx::sdk::Ptr<const nx::sdk::analytics::IUncompressedVideoFrame> videoFrame) override;

    virtual bool pushCompressedVideoFrame(
        nx::sdk::Ptr<const nx::sdk::analytics::ICompressedVideoPacket> videoFrame) override;

    virtual bool pullMetadataPackets(
        std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>* metadataPackets) override;

private:
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateObjectMetadataPacketFromDetections(
        const std::vector<Detection>& detections,
        const std::vector<nx::sdk::Uuid>& trackIds,
        int64_t timestampUs);
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateEventMetadataPacket(
        const std::string& eventTypeId,
        const std::string& caption,
        const std::string& description);

    std::string mapClassToObjectType(int classId) const;

    /**
     * Match new detections to existing tracked objects using IoU, assigning persistent track IDs
     * for stable bounding box display.
     *
     * @return One track Uuid per input detection, positionally aligned with `detections`. A null
     *     Uuid means the detection has no Nx object type and must not be reported.
     */
    std::vector<nx::sdk::Uuid> updateTrackedObjects(const std::vector<Detection>& detections);

    /**
     * Collects Best Shot packets for tracks that are ready for one. This tells the Nx Meta Server
     * to crop the frame at the given timestamp to the bounding box and use it as the thumbnail in
     * the right-side object panel.
     *
     * The caller MUST queue the object metadata packet for the current pass BEFORE these packets:
     * the Server silently discards a Best Shot for a track it has not registered yet.
     */
    std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>> collectBestShotPackets(
        int64_t timestampUs);

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

    static constexpr int64_t kInferenceIntervalUs = 200000; // 5 FPS throttle

    // Track lifetimes are counted in INFERENCE passes, not pushed frames. At 5 FPS inference on a
    // 25 FPS stream a frame-based budget is ~5x shorter than it reads, which expired tracks during
    // ordinary occlusions and collided with the Best Shot delay below.
    static constexpr int64_t kTrackExpiryInferences = 10;   // ~2s at 5 FPS
    static constexpr int64_t kBestShotDelayInferences = 3;  // ~0.6s for the Server to register it
    static constexpr float kIoUMatchThreshold = 0.3f;       // IoU threshold for track matching
    std::string m_deviceId;

    // Persistent object tracking state. Worker-thread only: created, matched, expired and read
    // exclusively inside workerLoop().
    std::vector<TrackedObject> m_trackedObjects;
    int64_t m_inferenceIndex = 0;

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
