// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Device Agent Implementation

#include "device_agent.h"

#include <chrono>
#include <cmath>
#include <iostream>
#include <algorithm>

#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/analytics/helpers/event_metadata.h>
#include <nx/sdk/analytics/helpers/event_metadata_packet.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/helpers/object_metadata_packet.h>

namespace magnet {
namespace analytics {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

// Object Type Identifiers
const std::string DeviceAgent::kCashierObjectType = "magnet.person.cashier";
const std::string DeviceAgent::kVisitorObjectType = "magnet.person.visitor";
const std::string DeviceAgent::kVehicleObjectType = "magnet.vehicle";
const std::string DeviceAgent::kPlateObjectType = "magnet.plate";
const std::string DeviceAgent::kHorseObjectType = "magnet.animal.horse";

// Event Type Identifiers
const std::string DeviceAgent::kCashierUnattendedEventType = "magnet.event.cashier_unattended";
const std::string DeviceAgent::kVisitorUnservedEventType = "magnet.event.visitor_unserved";
const std::string DeviceAgent::kOccupancyExceededEventType = "magnet.event.occupancy_exceeded";
const std::string DeviceAgent::kVehicleEntryEventType = "magnet.event.vehicle_entry";
const std::string DeviceAgent::kHorseDepartureEventType = "magnet.event.horse_departure";
const std::string DeviceAgent::kHorseReturnEventType = "magnet.event.horse_return";

DeviceAgent::DeviceAgent(
    const IDeviceInfo* deviceInfo,
    std::shared_ptr<YoloDetector> detector):
    ConsumingDeviceAgent(deviceInfo, /*enableOutput*/ true),
    m_detector(detector)
{
    if (deviceInfo && deviceInfo->id())
    {
        m_deviceId = deviceInfo->id();
    }
    m_workerThread = std::thread(&DeviceAgent::workerLoop, this);
}

DeviceAgent::~DeviceAgent()
{
    m_terminated = true;
    m_frameCv.notify_all();
    if (m_workerThread.joinable())
    {
        m_workerThread.join();
    }
}

/**
 * Manifest declaring supported object and event taxonomies for this camera stream.
 */
std::string DeviceAgent::manifestString() const
{
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "supportedTypes":
    [
        { "objectTypeId": "magnet.person.cashier" },
        { "objectTypeId": "magnet.person.visitor" },
        { "objectTypeId": "magnet.vehicle" },
        { "objectTypeId": "magnet.plate" },
        { "objectTypeId": "magnet.animal.horse" },
        { "eventTypeId": "magnet.event.cashier_unattended" },
        { "eventTypeId": "magnet.event.visitor_unserved" },
        { "eventTypeId": "magnet.event.occupancy_exceeded" },
        { "eventTypeId": "magnet.event.vehicle_entry" },
        { "eventTypeId": "magnet.event.horse_departure" },
        { "eventTypeId": "magnet.event.horse_return" }
    ],
    "typeLibrary":
    {
        "objectTypes":
        [
            {
                "id": "magnet.person.cashier",
                "name": "Magnet: Cashier Staff",
                "base": "nx.base.Person"
            },
            {
                "id": "magnet.person.visitor",
                "name": "Magnet: Visitor",
                "base": "nx.base.Person"
            },
            {
                "id": "magnet.vehicle",
                "name": "Magnet: Vehicle",
                "base": "nx.base.Vehicle"
            },
            {
                "id": "magnet.plate",
                "name": "Magnet: License Plate"
            },
            {
                "id": "magnet.animal.horse",
                "name": "Magnet: Riding Horse"
            }
        ],
        "eventTypes":
        [
            {
                "id": "magnet.event.cashier_unattended",
                "name": "Magnet: Cashier Desk Unattended"
            },
            {
                "id": "magnet.event.visitor_unserved",
                "name": "Magnet: Customer Waiting Alert"
            },
            {
                "id": "magnet.event.occupancy_exceeded",
                "name": "Magnet: Area Occupancy Exceeded"
            },
            {
                "id": "magnet.event.vehicle_entry",
                "name": "Magnet: Vehicle Entry Gate Crossing"
            },
            {
                "id": "magnet.event.horse_departure",
                "name": "Magnet: Horse Ride Departure"
            },
            {
                "id": "magnet.event.horse_return",
                "name": "Magnet: Horse Ride Return"
            }
        ]
    }
}
)json";
}

std::string DeviceAgent::mapClassToObjectType(int classId) const
{
    switch (classId)
    {
        case 0:  // COCO person
            return kVisitorObjectType;
        case 17: // COCO horse
            return kHorseObjectType;
        case 2:  // COCO car
        case 3:  // COCO motorcycle
        case 5:  // COCO bus
        case 7:  // COCO truck
            return kVehicleObjectType;
        default:
            return "";
    }
}

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

std::vector<nx::sdk::Uuid> DeviceAgent::updateTrackedObjects(
    const std::vector<Detection>& detections)
{
    // Index of the track each detection belongs to, or -1 for "no track" (unmappable class).
    std::vector<int> trackForDetection(detections.size(), -1);
    std::vector<bool> trackMatched(m_trackedObjects.size(), false);

    // 1. Greedy IoU matching: for each detection, find the best matching track of the same class
    for (size_t di = 0; di < detections.size(); ++di)
    {
        float bestIoU = kIoUMatchThreshold;
        int bestTrack = -1;

        for (size_t ti = 0; ti < m_trackedObjects.size(); ++ti)
        {
            if (trackMatched[ti])
                continue;

            // Only match objects of the same class type
            if (m_trackedObjects[ti].lastDetection.classId != detections[di].classId)
                continue;

            const float iou = computeIoU(m_trackedObjects[ti].lastDetection, detections[di]);
            if (iou > bestIoU)
            {
                bestIoU = iou;
                bestTrack = static_cast<int>(ti);
            }
        }

        if (bestTrack >= 0)
        {
            // Update existing track with new detection position
            m_trackedObjects[bestTrack].lastDetection = detections[di];
            m_trackedObjects[bestTrack].lastSeenInference = m_inferenceIndex;
            trackMatched[bestTrack] = true;
            trackForDetection[di] = bestTrack;
        }
    }

    // 2. Create new tracks for unmatched detections
    for (size_t di = 0; di < detections.size(); ++di)
    {
        if (trackForDetection[di] >= 0)
            continue;

        const std::string objectTypeId = mapClassToObjectType(detections[di].classId);
        if (objectTypeId.empty())
            continue;

        TrackedObject newTrack;
        newTrack.trackId = nx::sdk::UuidHelper::randomUuid();
        newTrack.lastDetection = detections[di];
        newTrack.firstSeenInference = m_inferenceIndex;
        newTrack.lastSeenInference = m_inferenceIndex;
        m_trackedObjects.push_back(newTrack);
        trackForDetection[di] = static_cast<int>(m_trackedObjects.size()) - 1;
    }

    // 3. Resolve track Uuids BEFORE expiry below invalidates the indices. Returning ids by value
    //    is what lets the caller stop re-deriving them by comparing detection floats for equality.
    std::vector<nx::sdk::Uuid> trackIds(detections.size());
    for (size_t di = 0; di < detections.size(); ++di)
    {
        if (trackForDetection[di] >= 0)
            trackIds[di] = m_trackedObjects[trackForDetection[di]].trackId;
    }

    // 4. Remove stale tracks that haven't been seen for too long
    m_trackedObjects.erase(
        std::remove_if(m_trackedObjects.begin(), m_trackedObjects.end(),
            [this](const TrackedObject& t) {
                return (m_inferenceIndex - t.lastSeenInference) > kTrackExpiryInferences;
            }),
        m_trackedObjects.end());

    return trackIds;
}

bool DeviceAgent::pushUncompressedVideoFrame(Ptr<const IUncompressedVideoFrame> videoFrame)
{
    ++m_frameIndex;
    m_lastVideoFrameTimestampUs = videoFrame->timestampUs();

    // 1. Non-blocking frame enqueue to background inference worker
    if (m_detector && m_detector->isLoaded())
    {
        if (m_lastVideoFrameTimestampUs - m_lastInferenceTimestampUs >= kInferenceIntervalUs)
        {
            std::unique_lock<std::mutex> lock(m_frameMutex, std::try_to_lock);
            if (lock.owns_lock())
            {
                m_pendingFrame = videoFrame;
                m_hasNewFrame = true;
                m_lastInferenceTimestampUs = m_lastVideoFrameTimestampUs;
                m_frameCv.notify_one();
            }
            // If lock was not acquired, background worker is still processing previous frame.
            // Returning immediately prevents decoder frame queue overflow in Nx Mediaserver.
        }
    }

    // 2. Periodic heartbeat audit event
    if (m_frameIndex % 300 == 0)
    {
        auto eventPacket = generateEventMetadataPacket(
            kCashierUnattendedEventType,
            "Magnet: AI Vision Active",
            "Real-time stream inference running on " + m_deviceId);
        pushMetadataPacket(eventPacket);
    }

    return true;
}

void DeviceAgent::workerLoop()
{
    while (!m_terminated.load())
    {
        nx::sdk::Ptr<const nx::sdk::analytics::IUncompressedVideoFrame> frame;
        {
            std::unique_lock<std::mutex> lock(m_frameMutex);
            m_frameCv.wait(lock, [this] {
                return m_hasNewFrame.load() || m_terminated.load();
            });

            if (m_terminated.load())
            {
                break;
            }

            frame = m_pendingFrame;
            m_pendingFrame = nullptr;
            m_hasNewFrame = false;
        }

        if (frame && m_detector && m_detector->isLoaded())
        {
            const auto detections = m_detector->detectFromYuv420(
                reinterpret_cast<const uint8_t*>(frame->data(0)),
                reinterpret_cast<const uint8_t*>(frame->data(1)),
                reinterpret_cast<const uint8_t*>(frame->data(2)),
                frame->lineSize(0),
                frame->lineSize(1),
                frame->lineSize(2),
                frame->width(),
                frame->height());

            // Advance the inference clock before tracking, so tracks created or matched in this
            // pass carry the current value.
            ++m_inferenceIndex;

            const auto trackIds = updateTrackedObjects(detections);

            // ORDER IS LOAD-BEARING. The object metadata packet is what registers a track with the
            // Server; a Best Shot naming a track the Server has not seen yet is discarded without
            // any error, which is why thumbnails used to appear only intermittently. Queue the
            // object packet first, Best Shots after.
            std::vector<Ptr<IMetadataPacket>> outgoing;

            if (!detections.empty())
            {
                outgoing.push_back(generateObjectMetadataPacketFromDetections(
                    detections, trackIds, frame->timestampUs()));
            }

            for (auto& bestShot: collectBestShotPackets(frame->timestampUs()))
                outgoing.push_back(bestShot);

            if (!outgoing.empty())
            {
                std::lock_guard<std::mutex> lock(m_resultsMutex);
                for (auto& packet: outgoing)
                    m_pendingResults.push_back(packet);
            }
        }
    }
}

bool DeviceAgent::pushCompressedVideoFrame(Ptr<const ICompressedVideoPacket> videoFrame)
{
    ++m_frameIndex;
    m_lastVideoFrameTimestampUs = videoFrame->timestampUs();
    return true;
}

bool DeviceAgent::pullMetadataPackets(std::vector<Ptr<IMetadataPacket>>* metadataPackets)
{
    // Deliver any async inference results that the worker thread has produced.
    // This method is called by the SDK after each doPushDataPacket(), so the
    // results are delivered synchronously from the Server's perspective.
    std::lock_guard<std::mutex> lock(m_resultsMutex);
    for (auto& pkt : m_pendingResults)
    {
        metadataPackets->push_back(pkt);
    }
    m_pendingResults.clear();

    return true;
}

Ptr<IMetadataPacket> DeviceAgent::generateObjectMetadataPacketFromDetections(
    const std::vector<Detection>& detections,
    const std::vector<nx::sdk::Uuid>& trackIds,
    int64_t timestampUs)
{
    const auto objectMetadataPacket = makePtr<ObjectMetadataPacket>();
    objectMetadataPacket->setTimestampUs(timestampUs);
    objectMetadataPacket->setDurationUs(0);

    for (size_t i = 0; i < detections.size(); ++i)
    {
        const Detection& det = detections[i];

        if (det.width <= 0.001f || det.height <= 0.001f)
            continue;

        const std::string objectTypeId = mapClassToObjectType(det.classId);
        if (objectTypeId.empty())
            continue;

        // A null Uuid means updateTrackedObjects() assigned no track to this detection, so there
        // is nothing for a Best Shot to attach to and the object must not be reported.
        if (i >= trackIds.size() || trackIds[i].isNull())
            continue;

        const auto obj = makePtr<ObjectMetadata>();
        obj->setTypeId(objectTypeId);
        obj->setTrackId(trackIds[i]);
        obj->setBoundingBox(Rect(det.x, det.y, det.width, det.height));
        obj->setConfidence(det.confidence);

        objectMetadataPacket->addItem(obj);
    }

    return objectMetadataPacket;
}

std::vector<Ptr<IMetadataPacket>> DeviceAgent::collectBestShotPackets(int64_t timestampUs)
{
    std::vector<Ptr<IMetadataPacket>> packets;

    for (auto& tracked: m_trackedObjects)
    {
        if (tracked.bestShotSent)
            continue;

        // Only a track matched in THIS pass has a bounding box that describes the frame at
        // timestampUs. Emitting for an unmatched track pairs a stale box with a fresh timestamp,
        // and the Server then crops background instead of the object.
        if (tracked.lastSeenInference != m_inferenceIndex)
            continue;

        // Give the Server a few passes to register the track before attaching a Best Shot to it.
        // The SDK's own stub sample does the same via a countdown; emitting on a track's first
        // frame is a race that the Best Shot loses silently.
        if (m_inferenceIndex - tracked.firstSeenInference < kBestShotDelayInferences)
            continue;

        if (mapClassToObjectType(tracked.lastDetection.classId).empty())
            continue;

        // No image data attached, so the Server crops this rectangle out of the frame at
        // timestampUs itself. IObjectTrackBestShotPacket0 requires a positive timestamp.
        packets.push_back(makePtr<ObjectTrackBestShotPacket>(
            tracked.trackId,
            timestampUs,
            Rect(tracked.lastDetection.x,
                 tracked.lastDetection.y,
                 tracked.lastDetection.width,
                 tracked.lastDetection.height)));

        tracked.bestShotSent = true;
    }

    return packets;
}

Ptr<IMetadataPacket> DeviceAgent::generateEventMetadataPacket(
    const std::string& eventTypeId,
    const std::string& caption,
    const std::string& description)
{
    const auto eventMetadataPacket = makePtr<EventMetadataPacket>();
    eventMetadataPacket->setTimestampUs(m_lastVideoFrameTimestampUs);
    eventMetadataPacket->setDurationUs(0);

    const auto eventMetadata = makePtr<EventMetadata>();
    eventMetadata->setTypeId(eventTypeId);
    eventMetadata->setIsActive(true);
    eventMetadata->setCaption(caption);
    eventMetadata->setDescription(description + " (#" + std::to_string(++m_eventCount) + ")");

    eventMetadataPacket->addItem(eventMetadata);
    return eventMetadataPacket;
}

} // namespace analytics
} // namespace magnet
