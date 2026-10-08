// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Base Device Agent Implementation

#include "base_device_agent.h"

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

const std::string BaseDeviceAgent::kByteTrackSetting = "useByteTrack";

BaseDeviceAgent::BaseDeviceAgent(
    const IDeviceInfo* deviceInfo,
    std::shared_ptr<YoloDetector> detector):
    ConsumingDeviceAgent(deviceInfo, /*enableOutput*/ true),
    m_detector(detector)
{
    if (deviceInfo && deviceInfo->id())
    {
        m_deviceId = deviceInfo->id();
    }
    m_workerThread = std::thread(&BaseDeviceAgent::workerLoop, this);
}

BaseDeviceAgent::~BaseDeviceAgent()
{
    m_terminated = true;
    m_frameCv.notify_all();
    if (m_workerThread.joinable())
    {
        m_workerThread.join();
    }
}

bool BaseDeviceAgent::pushUncompressedVideoFrame(
    Ptr<const IUncompressedVideoFrame> videoFrame)
{
    const int64_t currentTimestampUs = videoFrame->timestampUs();
    m_lastVideoFrameTimestampUs = currentTimestampUs;

    if (m_lastInferenceTimestampUs != 0 &&
        (currentTimestampUs - m_lastInferenceTimestampUs) < kInferenceIntervalUs)
    {
        return true;
    }

    m_lastInferenceTimestampUs = currentTimestampUs;

    {
        std::lock_guard<std::mutex> lock(m_frameMutex);
        if (m_hasNewFrame.load())
        {
            m_droppedFrameCount.fetch_add(1, std::memory_order_relaxed);
        }
        m_pendingFrame = videoFrame;
        m_hasNewFrame = true;
    }
    m_frameCv.notify_one();

    return true;
}

bool BaseDeviceAgent::pushCompressedVideoFrame(Ptr<const ICompressedVideoPacket> videoFrame)
{
    ++m_frameIndex;
    m_lastVideoFrameTimestampUs = videoFrame->timestampUs();
    return true;
}

bool BaseDeviceAgent::pullMetadataPackets(std::vector<Ptr<IMetadataPacket>>* metadataPackets)
{
    std::lock_guard<std::mutex> lock(m_resultsMutex);
    for (auto& pkt : m_pendingResults)
    {
        metadataPackets->push_back(pkt);
    }
    m_pendingResults.clear();
    return true;
}

std::vector<Detection> BaseDeviceAgent::filterReportableDetections(
    const std::vector<Detection>& detections) const
{
    std::vector<Detection> reportable;
    reportable.reserve(detections.size());
    for (const auto& det : detections)
    {
        if (det.width <= 0.001f || det.height <= 0.001f)
            continue;

        if (mapClassToObjectType(det.classId, det).empty())
            continue;

        reportable.push_back(det);
    }
    return reportable;
}

void BaseDeviceAgent::ensureRequestedTracker()
{
    const bool wantByteTrack = m_byteTrackRequested.load();
    if (m_tracker && wantByteTrack == m_trackerIsByteTrack)
        return;

    const bool isSwitch = (m_tracker != nullptr);

    if (wantByteTrack)
    {
        ByteTrackTracker::Params params;
        params.lostPasses = static_cast<int>(kTrackExpiryInferences);
        m_tracker = std::make_unique<ByteTrackTracker>(params);
    }
    else
    {
        m_tracker = std::make_unique<IouTracker>(
            kIoUTrackerMinConfidence, kIoUMatchThreshold, kTrackExpiryInferences);
    }
    m_trackerIsByteTrack = wantByteTrack;
    m_trackRecords.clear();

    std::cout << "[Magnet AI] device=" << m_deviceId << " tracker=" << m_tracker->name()
        << (isSwitch ? " (switched by settings; all tracks restarted)" : "") << std::endl;
}

std::vector<Uuid> BaseDeviceAgent::updateTrackRecords(const std::vector<TrackedDetection>& tracked)
{
    std::vector<Uuid> uuids;
    uuids.reserve(tracked.size());

    for (const auto& item : tracked)
    {
        auto found = m_trackRecords.find(item.trackKey);
        if (found == m_trackRecords.end())
        {
            TrackRecord record;
            record.uuid = UuidHelper::randomUuid();
            record.firstReportedInference = m_inferenceIndex;
            found = m_trackRecords.emplace(item.trackKey, record).first;
            ++m_stats.tracksCreated;
        }

        found->second.lastReportedInference = m_inferenceIndex;
        uuids.push_back(found->second.uuid);
    }

    for (auto it = m_trackRecords.begin(); it != m_trackRecords.end();)
    {
        if (m_inferenceIndex - it->second.lastReportedInference > kTrackExpiryInferences)
        {
            ++m_stats.tracksExpired;
            it = m_trackRecords.erase(it);
        }
        else
        {
            ++it;
        }
    }

    return uuids;
}

Ptr<IMetadataPacket> BaseDeviceAgent::generateObjectMetadataPacket(
    const std::vector<TrackedDetection>& tracked,
    const std::vector<Uuid>& uuids,
    int64_t timestampUs)
{
    const auto objectMetadataPacket = makePtr<ObjectMetadataPacket>();
    objectMetadataPacket->setTimestampUs(timestampUs);
    objectMetadataPacket->setDurationUs(0);

    for (size_t i = 0; i < tracked.size() && i < uuids.size(); ++i)
    {
        const Detection& det = tracked[i].detection;
        const std::string typeId = mapClassToObjectType(det.classId, det);
        if (typeId.empty())
            continue;

        const auto obj = makePtr<ObjectMetadata>();
        obj->setTypeId(typeId);
        obj->setTrackId(uuids[i]);
        obj->setBoundingBox(Rect(det.x, det.y, det.width, det.height));
        obj->setConfidence(det.confidence);

        objectMetadataPacket->addItem(obj);
    }

    return objectMetadataPacket;
}

std::vector<Ptr<IMetadataPacket>> BaseDeviceAgent::collectBestShotPackets(
    const std::vector<TrackedDetection>& tracked,
    const std::vector<Uuid>& uuids,
    int64_t timestampUs)
{
    std::vector<Ptr<IMetadataPacket>> packets;

    for (size_t i = 0; i < tracked.size() && i < uuids.size(); ++i)
    {
        const auto record = m_trackRecords.find(tracked[i].trackKey);
        if (record == m_trackRecords.end() || record->second.bestShotSent)
            continue;

        if (m_inferenceIndex - record->second.firstReportedInference < kBestShotDelayInferences)
            continue;

        const Detection& det = tracked[i].detection;
        packets.push_back(makePtr<ObjectTrackBestShotPacket>(
            uuids[i],
            timestampUs,
            Rect(det.x, det.y, det.width, det.height)));

        record->second.bestShotSent = true;
    }

    return packets;
}

void BaseDeviceAgent::recordPassAndMaybeLogStats(int64_t inferenceUs, size_t bestShotCount)
{
    const auto now = std::chrono::steady_clock::now();

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

Ptr<IMetadataPacket> BaseDeviceAgent::createEventPacket(
    const std::string& eventTypeId,
    const std::string& caption,
    const std::string& description,
    int64_t timestampUs)
{
    const auto eventMetadataPacket = makePtr<EventMetadataPacket>();
    eventMetadataPacket->setTimestampUs(timestampUs > 0 ? timestampUs : m_lastVideoFrameTimestampUs);
    eventMetadataPacket->setDurationUs(0);

    const auto eventMetadata = makePtr<EventMetadata>();
    eventMetadata->setTypeId(eventTypeId);
    eventMetadata->setIsActive(true);
    eventMetadata->setCaption(caption);
    eventMetadata->setDescription(description + " (#" + std::to_string(++m_eventCount) + ")");

    eventMetadataPacket->addItem(eventMetadata);
    return eventMetadataPacket;
}

void BaseDeviceAgent::workerLoop()
{
    while (!m_terminated)
    {
        Ptr<const IUncompressedVideoFrame> frame;
        {
            std::unique_lock<std::mutex> lock(m_frameMutex);
            m_frameCv.wait(lock, [this]() {
                return m_hasNewFrame.load() || m_terminated.load();
            });

            if (m_terminated)
                break;

            frame = m_pendingFrame;
            m_pendingFrame = nullptr;
            m_hasNewFrame = false;
        }

        if (frame && m_detector && m_detector->isLoaded())
        {
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

            ++m_inferenceIndex;
            ensureRequestedTracker();

            const auto reportableDetections = filterReportableDetections(detections);
            const auto tracked = m_tracker->update(
                reportableDetections, frame->width(), frame->height());
            const auto uuids = updateTrackRecords(tracked);

            std::vector<Ptr<IMetadataPacket>> outgoing;

            if (!tracked.empty())
            {
                outgoing.push_back(generateObjectMetadataPacket(
                    tracked, uuids, frame->timestampUs()));
            }

            const auto bestShots = collectBestShotPackets(tracked, uuids, frame->timestampUs());
            for (auto& bestShot : bestShots)
            {
                outgoing.push_back(bestShot);
            }

            // Domain rule event processing hook
            processTracks(tracked, frame->timestampUs(), outgoing);

            if (!outgoing.empty())
            {
                std::lock_guard<std::mutex> lock(m_resultsMutex);
                for (auto& packet : outgoing)
                {
                    m_pendingResults.push_back(packet);
                }
            }

            recordPassAndMaybeLogStats(inferenceUs, bestShots.size());
        }
    }
}

} // namespace analytics
} // namespace magnet
