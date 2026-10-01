// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Device Agent Implementation

#include "device_agent.h"

#include <chrono>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <algorithm>

#include <nx/kit/utils.h>
#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/analytics/helpers/event_metadata.h>
#include <nx/sdk/analytics/helpers/event_metadata_packet.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/helpers/object_metadata_packet.h>

#include "byte_track_tracker.h"
#include "iou_tracker.h"

namespace magnet {
namespace analytics {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

const std::string DeviceAgent::kByteTrackSetting = "useByteTrack";

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

Result<const ISettingsResponse*> DeviceAgent::settingsReceived()
{
    // Runs on a Server thread, not the worker: only record the request here. The worker swaps
    // trackers at the start of its next pass (ensureRequestedTracker).
    bool useByteTrack = false;
    nx::kit::utils::fromString(settingValue(kByteTrackSetting), &useByteTrack);
    m_byteTrackRequested = useByteTrack;
    return nullptr;
}

std::vector<Detection> DeviceAgent::filterReportableDetections(
    const std::vector<Detection>& detections) const
{
    std::vector<Detection> reportable;
    reportable.reserve(detections.size());
    for (const auto& det: detections)
    {
        if (det.width <= 0.001f || det.height <= 0.001f)
            continue;

        if (mapClassToObjectType(det.classId).empty())
            continue;

        reportable.push_back(det);
    }
    return reportable;
}

void DeviceAgent::ensureRequestedTracker()
{
    const bool wantByteTrack = m_byteTrackRequested.load();
    if (m_tracker && wantByteTrack == m_trackerIsByteTrack)
        return;

    const bool isSwitch = (m_tracker != nullptr);

    if (wantByteTrack)
    {
        ByteTrackTracker::Params params;
        // Lost tracks live exactly as long as IoU tracks do, so the two trackers' tracks_created
        // and tracks_expired figures are directly comparable on the same clip.
        params.lostPasses = static_cast<int>(kTrackExpiryInferences);
        m_tracker = std::make_unique<ByteTrackTracker>(params);
    }
    else
    {
        m_tracker = std::make_unique<IouTracker>(
            kIoUTrackerMinConfidence, kIoUMatchThreshold, kTrackExpiryInferences);
    }
    m_trackerIsByteTrack = wantByteTrack;

    // The new tracker's keys mean nothing to the old records.
    m_trackRecords.clear();

    std::cout << "[Magnet AI] device=" << m_deviceId << " tracker=" << m_tracker->name()
        << (isSwitch ? " (switched by settings; all tracks restarted)" : "") << std::endl;
}

std::vector<nx::sdk::Uuid> DeviceAgent::updateTrackRecords(
    const std::vector<TrackedDetection>& tracked)
{
    std::vector<nx::sdk::Uuid> uuids;
    uuids.reserve(tracked.size());

    for (const auto& item: tracked)
    {
        auto found = m_trackRecords.find(item.trackKey);
        if (found == m_trackRecords.end())
        {
            TrackRecord record;
            record.uuid = nx::sdk::UuidHelper::randomUuid();
            record.firstReportedInference = m_inferenceIndex;
            found = m_trackRecords.emplace(item.trackKey, record).first;
            ++m_stats.tracksCreated;
        }

        found->second.lastReportedInference = m_inferenceIndex;
        uuids.push_back(found->second.uuid);
    }

    // Both trackers drop a track once it has gone unreported for more than kTrackExpiryInferences
    // passes, after which its key can never be reported again.
    for (auto it = m_trackRecords.begin(); it != m_trackRecords.end();)
    {
        if (m_inferenceIndex - it->second.lastReportedInference > kTrackExpiryInferences)
        {
            it = m_trackRecords.erase(it);
            ++m_stats.tracksExpired;
        }
        else
        {
            ++it;
        }
    }

    return uuids;
}

bool DeviceAgent::pushUncompressedVideoFrame(Ptr<const IUncompressedVideoFrame> videoFrame)
{
    ++m_frameIndex;
    m_lastVideoFrameTimestampUs = videoFrame->timestampUs();

    // 1. Report startup state exactly once, through the Server's diagnostic channel rather than
    //    stderr. A model that fails to load otherwise leaves the plugin visible in Nx, silently
    //    producing nothing, with the only trace buried in the mediaserver's stdout.
    if (!m_startupDiagnosticSent)
    {
        m_startupDiagnosticSent = true;

        if (!m_detector)
        {
            pushIntegrationDiagnosticEvent(
                IIntegrationDiagnosticEvent::Level::error,
                "Magnet AI: no detector",
                "No YOLO detector was supplied to the device agent for " + m_deviceId
                    + ". No analytics will be produced on this stream.");
        }
        else if (!m_detector->isLoaded())
        {
            pushIntegrationDiagnosticEvent(
                IIntegrationDiagnosticEvent::Level::error,
                "Magnet AI: model failed to load",
                "The ONNX model could not be loaded, so no analytics will be produced on "
                    + m_deviceId + ". Verify the model exists under the mediaserver plugins "
                    "directory or set MAGNET_MODEL_PATH.");
        }
        else
        {
            pushIntegrationDiagnosticEvent(
                IIntegrationDiagnosticEvent::Level::info,
                "Magnet AI: inference active",
                "YOLO inference started on " + m_deviceId + ".");
        }
    }

    // 2. Non-blocking frame enqueue to background inference worker
    if (m_detector && m_detector->isLoaded())
    {
        if (m_lastVideoFrameTimestampUs - m_lastInferenceTimestampUs >= kInferenceIntervalUs)
        {
            std::unique_lock<std::mutex> lock(m_frameMutex, std::try_to_lock);
            if (lock.owns_lock())
            {
                // The worker does not hold m_frameMutex while it runs inference, so a busy worker
                // shows up HERE, as a queued frame it never picked up. Replacing that frame drops
                // it; this is the drop that matters when inference is slower than
                // kInferenceIntervalUs, and it destabilises IoU track matching.
                if (m_hasNewFrame)
                    ++m_droppedFrameCount;

                m_pendingFrame = videoFrame;
                m_hasNewFrame = true;
                m_lastInferenceTimestampUs = m_lastVideoFrameTimestampUs;
                m_frameCv.notify_one();
            }
            else
            {
                // Rare: the worker is taking the queued frame at this very instant. Skip this one
                // rather than block the Server's frame-push thread.
                ++m_droppedFrameCount;
            }
        }
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
            // Includes any wait on YoloDetector's inference mutex, which is shared by every camera,
            // so on a multi-camera server this is the real per-pass cost, contention included.
            const auto inferenceStart = std::chrono::steady_clock::now();
            const auto detections = m_detector->detectFromYuv420(
                reinterpret_cast<const uint8_t*>(frame->data(0)),
                reinterpret_cast<const uint8_t*>(frame->data(1)),
                reinterpret_cast<const uint8_t*>(frame->data(2)),
                frame->lineSize(0),
                frame->lineSize(1),
                frame->lineSize(2),
                frame->width(),
                frame->height());
            const int64_t inferenceUs = std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - inferenceStart).count();

            // Advance the inference clock before tracking, so tracks created or matched in this
            // pass carry the current value.
            ++m_inferenceIndex;

            // Called every pass, even with no detections: that is how trackers age and expire
            // tracks.
            ensureRequestedTracker();
            const auto tracked = m_tracker->update(
                filterReportableDetections(detections), frame->width(), frame->height());
            const auto uuids = updateTrackRecords(tracked);

            // ORDER IS LOAD-BEARING. The object metadata packet is what registers a track with the
            // Server; a Best Shot naming a track the Server has not seen yet is discarded without
            // any error, which is why thumbnails used to appear only intermittently. Queue the
            // object packet first, Best Shots after.
            std::vector<Ptr<IMetadataPacket>> outgoing;

            if (!tracked.empty())
            {
                outgoing.push_back(generateObjectMetadataPacket(
                    tracked, uuids, frame->timestampUs()));
            }

            const auto bestShots = collectBestShotPackets(tracked, uuids, frame->timestampUs());
            for (auto& bestShot: bestShots)
                outgoing.push_back(bestShot);

            if (!outgoing.empty())
            {
                std::lock_guard<std::mutex> lock(m_resultsMutex);
                for (auto& packet: outgoing)
                    m_pendingResults.push_back(packet);
            }

            recordPassAndMaybeLogStats(inferenceUs, bestShots.size());
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

Ptr<IMetadataPacket> DeviceAgent::generateObjectMetadataPacket(
    const std::vector<TrackedDetection>& tracked,
    const std::vector<nx::sdk::Uuid>& uuids,
    int64_t timestampUs)
{
    const auto objectMetadataPacket = makePtr<ObjectMetadataPacket>();
    objectMetadataPacket->setTimestampUs(timestampUs);
    objectMetadataPacket->setDurationUs(0);

    for (size_t i = 0; i < tracked.size() && i < uuids.size(); ++i)
    {
        const Detection& det = tracked[i].detection;

        // Trackers only see detections that passed filterReportableDetections(), so every class
        // here maps to an object type.
        const auto obj = makePtr<ObjectMetadata>();
        obj->setTypeId(mapClassToObjectType(det.classId));
        obj->setTrackId(uuids[i]);
        obj->setBoundingBox(Rect(det.x, det.y, det.width, det.height));
        obj->setConfidence(det.confidence);

        objectMetadataPacket->addItem(obj);
    }

    return objectMetadataPacket;
}

std::vector<Ptr<IMetadataPacket>> DeviceAgent::collectBestShotPackets(
    const std::vector<TrackedDetection>& tracked,
    const std::vector<nx::sdk::Uuid>& uuids,
    int64_t timestampUs)
{
    std::vector<Ptr<IMetadataPacket>> packets;

    // Only tracks reported in THIS pass are candidates: their box describes the frame at
    // timestampUs. Emitting for a track not seen this pass would pair a stale box with a fresh
    // timestamp, and the Server would then crop background instead of the object.
    for (size_t i = 0; i < tracked.size() && i < uuids.size(); ++i)
    {
        const auto record = m_trackRecords.find(tracked[i].trackKey);
        if (record == m_trackRecords.end() || record->second.bestShotSent)
            continue;

        // Withhold the Best Shot for a few passes after the track is first reported (ADR-006
        // decision 3; ADR-006 open item 6 notes the SDK does not strictly require the delay).
        if (m_inferenceIndex - record->second.firstReportedInference < kBestShotDelayInferences)
            continue;

        const Detection& det = tracked[i].detection;

        // No image data attached, so the Server crops this rectangle out of the frame at
        // timestampUs itself. IObjectTrackBestShotPacket0 requires a positive timestamp.
        packets.push_back(makePtr<ObjectTrackBestShotPacket>(
            uuids[i],
            timestampUs,
            Rect(det.x, det.y, det.width, det.height)));

        record->second.bestShotSent = true;
    }

    return packets;
}

void DeviceAgent::recordPassAndMaybeLogStats(int64_t inferenceUs, size_t bestShotCount)
{
    const auto now = std::chrono::steady_clock::now();

    // Windows are back-to-back: only the very first one starts at a pass, every later one starts
    // where the previous log line ended, so idle time between passes is counted against the rate.
    if (m_stats.start == std::chrono::steady_clock::time_point())
    {
        m_stats.start = now;
        m_stats.droppedFramesAtStart = m_droppedFrameCount.load();
    }

    ++m_stats.passes;
    m_stats.inferenceUsTotal += inferenceUs;
    m_stats.inferenceUsMax = std::max(m_stats.inferenceUsMax, inferenceUs);
    m_stats.bestShotsSent += static_cast<int64_t>(bestShotCount);

    const auto elapsed = now - m_stats.start;
    if (elapsed < kStatsInterval)
        return;

    const double elapsedS = std::chrono::duration<double>(elapsed).count();
    const int64_t droppedFrames = m_droppedFrameCount.load();

    // "dropped" counts frames that passed the kInferenceIntervalUs throttle but were never
    // inferred, so passes + dropped ~= target x window. "rate" against "target" is the headline.
    std::ostringstream line;
    line << std::fixed
        << "[Magnet AI Stats] device=" << m_deviceId
        << " tracker=" << (m_tracker ? m_tracker->name() : "none")
        << " window=" << std::setprecision(1) << elapsedS << "s"
        << std::setprecision(2)
        << " passes=" << m_stats.passes
        << " rate=" << (m_stats.passes / elapsedS) << "/s"
        << " target=" << (1e6 / kInferenceIntervalUs) << "/s"
        << " infer_avg=" << (m_stats.inferenceUsTotal / m_stats.passes / 1000) << "ms"
        << " infer_max=" << (m_stats.inferenceUsMax / 1000) << "ms"
        << " dropped=" << (droppedFrames - m_stats.droppedFramesAtStart)
        << " tracks_created=" << m_stats.tracksCreated
        << " tracks_expired=" << m_stats.tracksExpired
        << " live_tracks=" << m_trackRecords.size()
        << " best_shots=" << m_stats.bestShotsSent;
    std::cout << line.str() << std::endl;

    m_stats = StatsWindow();
    m_stats.start = now;
    m_stats.droppedFramesAtStart = droppedFrames;
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
