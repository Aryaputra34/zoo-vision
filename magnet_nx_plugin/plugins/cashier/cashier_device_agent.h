// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier Device Agent Header

#pragma once

#include <mutex>
#include <set>
#include <map>
#include <string>
#include <vector>

#include "core/base_device_agent.h"
#include "core/geometry_utils.h"

namespace magnet {
namespace analytics {
namespace cashier {

class CashierDeviceAgent: public BaseDeviceAgent
{
public:
    CashierDeviceAgent(
        const nx::sdk::IDeviceInfo* deviceInfo,
        std::shared_ptr<YoloDetector> detector);
    virtual ~CashierDeviceAgent() override;

protected:
    virtual std::string manifestString() const override;
    virtual nx::sdk::Result<const nx::sdk::ISettingsResponse*> settingsReceived() override;

    virtual std::string mapClassToObjectType(int classId, const Detection& det) const override;

    virtual void processTracks(
        const std::vector<TrackedDetection>& tracked,
        int64_t timestampUs,
        std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>& outPackets) override;

private:
    mutable std::mutex m_configMutex;
    Polygon m_cashierZone;
    Polygon m_queueZone;
    int m_unattendedThresholdSec = 10;
    int m_waitingThresholdSec = 10;

    // Cashier unstaffed state machine (steady_clock ensures accuracy even on looped RTSP streams)
    std::chrono::steady_clock::time_point m_cashierEmptySince;
    std::chrono::steady_clock::time_point m_lastCashierAlertTime;

    // Combined alert: Customer waiting while cashier desk is unstaffed
    std::chrono::steady_clock::time_point m_customerWaitingAtEmptyDeskSince;
    std::chrono::steady_clock::time_point m_lastCustomerWaitingAlertTime;

    // Debounce / presence grace periods to prevent single-frame flickers from resetting timers
    std::chrono::steady_clock::time_point m_lastCustomerSeenTime;
    std::chrono::steady_clock::time_point m_lastStaffSeenTime;
    std::chrono::steady_clock::time_point m_lastPeriodicLogTime;

    // Visitor queue dwell state machine
    std::map<int64_t, std::chrono::steady_clock::time_point> m_visitorQueueEntryTimes;
    std::map<int64_t, std::chrono::steady_clock::time_point> m_visitorLastAlertTimes;
    std::map<int64_t, std::chrono::steady_clock::time_point> m_visitorQueueLostTimes;
};

} // namespace cashier
} // namespace analytics
} // namespace magnet
