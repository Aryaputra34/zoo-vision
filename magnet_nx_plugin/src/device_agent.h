// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Device Agent Header

#pragma once

#include <string>
#include <vector>
#include <cstdint>

#include <nx/sdk/analytics/helpers/consuming_device_agent.h>
#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/analytics/i_uncompressed_video_frame.h>

namespace magnet {
namespace analytics {

class DeviceAgent: public nx::sdk::analytics::ConsumingDeviceAgent
{
public:
    DeviceAgent(const nx::sdk::IDeviceInfo* deviceInfo);
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
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateObjectMetadataPacket();
    nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket> generateEventMetadataPacket(
        const std::string& eventTypeId,
        const std::string& caption,
        const std::string& description);

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

private:
    nx::sdk::Uuid m_trackId = nx::sdk::UuidHelper::randomUuid();
    int64_t m_frameIndex = 0;
    int64_t m_eventCount = 0;
    int64_t m_lastVideoFrameTimestampUs = 0;
    std::string m_deviceId;
};

} // namespace analytics
} // namespace magnet
