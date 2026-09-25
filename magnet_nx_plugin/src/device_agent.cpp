// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Device Agent Implementation

#include "device_agent.h"

#include <chrono>
#include <cmath>

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

DeviceAgent::DeviceAgent(const IDeviceInfo* deviceInfo):
    ConsumingDeviceAgent(deviceInfo, /*enableOutput*/ true)
{
    if (deviceInfo && deviceInfo->id())
    {
        m_deviceId = deviceInfo->id();
    }
}

DeviceAgent::~DeviceAgent()
{
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
        { "eventTypeId": "magnet.event.horse_departure" }
    ],
    "typeLibrary":
    {
        "objectTypes":
        [
            {
                "id": "magnet.person.cashier",
                "name": "Magnet: Cashier Staff"
            },
            {
                "id": "magnet.person.visitor",
                "name": "Magnet: Visitor"
            },
            {
                "id": "magnet.vehicle",
                "name": "Magnet: Vehicle"
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
                "name": "Magnet: Horse Departure Count"
            }
        ]
    }
}
)json";
}

bool DeviceAgent::pushUncompressedVideoFrame(Ptr<const IUncompressedVideoFrame> videoFrame)
{
    ++m_frameIndex;
    m_lastVideoFrameTimestampUs = videoFrame->timestampUs();

    // Trigger test event every 300 frames (~10 seconds at 30fps) to verify Nx notification pipeline
    if (m_frameIndex % 300 == 0)
    {
        auto eventPacket = generateEventMetadataPacket(
            kCashierUnattendedEventType,
            "Magnet: Cashier Audit Active",
            "Continuous presence monitoring active on stream " + m_deviceId);
        pushMetadataPacket(eventPacket);
    }

    return true;
}

bool DeviceAgent::pushCompressedVideoFrame(Ptr<const ICompressedVideoPacket> videoFrame)
{
    ++m_frameIndex;
    m_lastVideoFrameTimestampUs = videoFrame->timestampUs();
    return true;
}

bool DeviceAgent::pullMetadataPackets(std::vector<Ptr<IMetadataPacket>>* metadataPackets)
{
    if (m_lastVideoFrameTimestampUs > 0)
    {
        metadataPackets->push_back(generateObjectMetadataPacket());
    }
    return true;
}

Ptr<IMetadataPacket> DeviceAgent::generateObjectMetadataPacket()
{
    const auto objectMetadataPacket = makePtr<ObjectMetadataPacket>();
    objectMetadataPacket->setTimestampUs(m_lastVideoFrameTimestampUs);
    objectMetadataPacket->setDurationUs(0);

    // Generate smooth circulating demo bounding box to verify live UI overlay in Nx Desktop
    const auto cashierMetadata = makePtr<ObjectMetadata>();
    cashierMetadata->setTypeId(kCashierObjectType);
    cashierMetadata->setTrackId(m_trackId);

    // Bounding box with gentle harmonic motion [0.1 .. 0.7]
    const float t = static_cast<float>(m_frameIndex % 360) * 3.14159f / 180.0f;
    const float x = 0.35f + 0.15f * std::cos(t);
    const float y = 0.35f + 0.15f * std::sin(t);
    const float width = 0.15f;
    const float height = 0.25f;

    cashierMetadata->setBoundingBox(Rect(x, y, width, height));
    objectMetadataPacket->addItem(cashierMetadata);

    return objectMetadataPacket;
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
