// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier Device Agent Implementation

#include "cashier_device_agent.h"
#include "cashier_manifest.h"

#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <ctime>
#include <nx/kit/utils.h>

namespace magnet {
namespace analytics {
namespace cashier {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

static void logCashierDebug(const std::string& msg)
{
    static std::ofstream logFile("d:/WORK/zoo-vision/magnet_nx_plugin/cashier_debug.log", std::ios::app);
    if (logFile.is_open())
    {
        const auto now = std::chrono::system_clock::now();
        const auto time_t_now = std::chrono::system_clock::to_time_t(now);
        struct tm tm_buf;
        localtime_s(&tm_buf, &time_t_now);
        char timeStr[32];
        std::strftime(timeStr, sizeof(timeStr), "%H:%M:%S", &tm_buf);
        logFile << "[" << timeStr << "] [Magnet Cashier] " << msg << std::endl;
        logFile.flush();
    }
}

CashierDeviceAgent::CashierDeviceAgent(
    const IDeviceInfo* deviceInfo,
    std::shared_ptr<YoloDetector> detector):
    BaseDeviceAgent(deviceInfo, detector)
{
    logCashierDebug("CashierDeviceAgent created for device=" + m_deviceId);
}

CashierDeviceAgent::~CashierDeviceAgent()
{
    logCashierDebug("CashierDeviceAgent destroyed for device=" + m_deviceId);
}

std::string CashierDeviceAgent::manifestString() const
{
    return deviceAgentManifest();
}

Result<const ISettingsResponse*> CashierDeviceAgent::settingsReceived()
{
    std::lock_guard<std::mutex> lock(m_configMutex);

    // ByteTrack tracker toggle
    bool useByteTrack = true;
    if (nx::kit::utils::fromString(settingValue(kByteTrackSetting), &useByteTrack))
    {
        setByteTrackRequested(useByteTrack);
    }

    // Thresholds
    int unattendedSec = 10;
    if (nx::kit::utils::fromString(settingValue("unattendedThresholdSec"), &unattendedSec))
    {
        m_unattendedThresholdSec = std::max(1, unattendedSec);
        std::cout << "[Magnet Cashier] Configured unattendedThresholdSec=" << m_unattendedThresholdSec << "s" << std::endl;
        logCashierDebug("Configured unattendedThresholdSec=" + std::to_string(m_unattendedThresholdSec) + "s");
    }

    int waitingSec = 10;
    if (nx::kit::utils::fromString(settingValue("waitingThresholdSec"), &waitingSec))
    {
        m_waitingThresholdSec = std::max(1, waitingSec);
        std::cout << "[Magnet Cashier] Configured waitingThresholdSec=" << m_waitingThresholdSec << "s" << std::endl;
        logCashierDebug("Configured waitingThresholdSec=" + std::to_string(m_waitingThresholdSec) + "s");
    }

    // Polygons
    const std::string cashierZoneStr = settingValue("cashierZone");
    if (!cashierZoneStr.empty())
    {
        m_cashierZone = parsePolygonString(cashierZoneStr);
        std::cout << "[Magnet Cashier] Updated cashierZone points=" << m_cashierZone.size() << std::endl;
        logCashierDebug("Updated cashierZone points=" + std::to_string(m_cashierZone.size()));
    }

    const std::string queueZoneStr = settingValue("queueZone");
    if (!queueZoneStr.empty())
    {
        m_queueZone = parsePolygonString(queueZoneStr);
        std::cout << "[Magnet Cashier] Updated queueZone points=" << m_queueZone.size() << std::endl;
        logCashierDebug("Updated queueZone points=" + std::to_string(m_queueZone.size()));
    }

    return nullptr;
}

std::string CashierDeviceAgent::mapClassToObjectType(int classId, const Detection& det) const
{
    // Cashier analytics only reports persons (COCO class 0)
    if (classId != 0)
        return "";

    std::lock_guard<std::mutex> lock(m_configMutex);

    const bool hasZones = (!m_cashierZone.empty() || !m_queueZone.empty());

    // 1. Check customer queue zone FIRST!
    // A customer standing in front of the counter must NEVER be misidentified as cashier staff
    if (!m_queueZone.empty() && isDetectionInZone(det, m_queueZone))
    {
        return "magnet.person.visitor";
    }

    // 2. Check cashier staff zone (behind the desk)
    if (!m_cashierZone.empty() && isDetectionInZone(det, m_cashierZone))
    {
        return "magnet.person.cashier";
    }

    // When zones are configured, strictly ignore anyone outside the polygons (filters background pedestrians)
    if (hasZones)
    {
        return "";
    }

    // If no zones configured yet, show unassigned visitor for setup preview
    return "magnet.person.visitor";
}

void CashierDeviceAgent::processTracks(
    const std::vector<TrackedDetection>& tracked,
    int64_t timestampUs,
    std::vector<Ptr<IMetadataPacket>>& outPackets)
{
    Polygon cashierZone;
    Polygon queueZone;
    int unattendedSec = 10;
    int waitingSec = 10;
    {
        std::lock_guard<std::mutex> lock(m_configMutex);
        cashierZone = m_cashierZone;
        queueZone = m_queueZone;
        unattendedSec = m_unattendedThresholdSec;
        waitingSec = m_waitingThresholdSec;
    }

    const auto now = std::chrono::steady_clock::now();
    int cashiersInDesk = 0;
    std::set<int64_t> activeQueueTrackKeys;

    for (const auto& item : tracked)
    {
        if (item.detection.classId != 0)
            continue;

        const bool inQueue = (!queueZone.empty() && isDetectionInZone(item.detection, queueZone));
        const bool inCashier = (!cashierZone.empty() && isDetectionInZone(item.detection, cashierZone));

        // Strict disambiguation: Queue zone takes precedence for customers in front of counter
        if (inQueue)
        {
            activeQueueTrackKeys.insert(item.trackKey);
        }
        else if (inCashier)
        {
            // Only count as cashier staff if NOT in the customer queue zone
            ++cashiersInDesk;
        }
    }

    // Maintain presence grace periods (1.5 seconds) to survive 1-2 frames of detection jitter / track key handover
    const bool customerPresent = !activeQueueTrackKeys.empty();
    const bool staffPresent = (cashiersInDesk > 0);

    if (customerPresent)
        m_lastCustomerSeenTime = now;
    if (staffPresent)
        m_lastStaffSeenTime = now;

    const bool customerPresentDebounced = customerPresent ||
        (m_lastCustomerSeenTime != std::chrono::steady_clock::time_point() &&
         std::chrono::duration_cast<std::chrono::milliseconds>(now - m_lastCustomerSeenTime).count() < 1500);

    const bool staffPresentDebounced = staffPresent ||
        (m_lastStaffSeenTime != std::chrono::steady_clock::time_point() &&
         std::chrono::duration_cast<std::chrono::milliseconds>(now - m_lastStaffSeenTime).count() < 1500);

    // Track entry times for active queue visitors with grace period
    for (const auto key : activeQueueTrackKeys)
    {
        if (m_visitorQueueEntryTimes.find(key) == m_visitorQueueEntryTimes.end())
        {
            m_visitorQueueEntryTimes[key] = now;
            logCashierDebug("Customer #" + std::to_string(key) + " entered queueZone.");
        }
        m_visitorQueueLostTimes.erase(key);
    }

    // =========================================================================
    // RULE 1: Urgent Alert - Customer Waiting while Cashier Desk is Unattended
    // (Triggers when customer is in queue and NO cashier is at desk for >= threshold)
    // =========================================================================
    if (customerPresentDebounced && !staffPresentDebounced)
    {
        if (m_customerWaitingAtEmptyDeskSince == std::chrono::steady_clock::time_point())
        {
            m_customerWaitingAtEmptyDeskSince = now;
            logCashierDebug("Customer waiting at unstaffed desk. Alert timer started.");
        }

        const auto waitDurationSec = std::chrono::duration_cast<std::chrono::seconds>(
            now - m_customerWaitingAtEmptyDeskSince).count();

        const int urgentThresholdSec = std::min(waitingSec, unattendedSec);

        if (waitDurationSec >= urgentThresholdSec)
        {
            const bool canAlert = (m_lastCustomerWaitingAlertTime == std::chrono::steady_clock::time_point() ||
                std::chrono::duration_cast<std::chrono::seconds>(now - m_lastCustomerWaitingAlertTime).count() >= 15);

            if (canAlert)
            {
                const std::string caption = "Customer Waiting at Unattended Desk";
                const std::string desc = "Customer waiting for > " + std::to_string(waitDurationSec) +
                    "s while cashier desk is unstaffed";

                // Formal Nx Analytics Event packet (for Analytics DB and Event Rules)
                outPackets.push_back(createEventPacket(
                    "magnet.event.visitor_unserved",
                    caption,
                    desc,
                    timestampUs));

                // Direct Integration Diagnostic Event (pops up immediately in Nx Desktop notifications without manual rule)
                pushIntegrationDiagnosticEvent(
                    nx::sdk::IIntegrationDiagnosticEvent::Level::warning,
                    "[URGENT] " + caption,
                    desc);

                m_lastCustomerWaitingAlertTime = now;
                logCashierDebug("ALERT TRIGGERED: [URGENT] " + caption + " (" + std::to_string(waitDurationSec) + "s)");
                std::cout << "[Magnet Cashier ALERT] [URGENT] " << caption << " (" << waitDurationSec << "s)" << std::endl;
            }
        }
    }
    else
    {
        if (m_customerWaitingAtEmptyDeskSince != std::chrono::steady_clock::time_point())
        {
            m_customerWaitingAtEmptyDeskSince = std::chrono::steady_clock::time_point();
        }
    }

    // =========================================================================
    // RULE 2: Cashier Desk Unattended (General unstaffed alert)
    // =========================================================================
    if (!cashierZone.empty())
    {
        if (!staffPresentDebounced)
        {
            if (m_cashierEmptySince == std::chrono::steady_clock::time_point())
            {
                m_cashierEmptySince = now;
                logCashierDebug("Cashier desk unstaffed. Timer started (threshold: " + std::to_string(unattendedSec) + "s)");
            }

            const auto emptySec = std::chrono::duration_cast<std::chrono::seconds>(
                now - m_cashierEmptySince).count();

            if (emptySec >= unattendedSec)
            {
                const bool canAlert = (m_lastCashierAlertTime == std::chrono::steady_clock::time_point() ||
                    std::chrono::duration_cast<std::chrono::seconds>(now - m_lastCashierAlertTime).count() >= 30);

                if (canAlert)
                {
                    const std::string caption = "Cashier Desk Unattended";
                    const std::string desc = "Cashier desk has been unstaffed for > " + std::to_string(emptySec) + "s";

                    outPackets.push_back(createEventPacket(
                        "magnet.event.cashier_unattended",
                        caption,
                        desc,
                        timestampUs));

                    pushIntegrationDiagnosticEvent(
                        nx::sdk::IIntegrationDiagnosticEvent::Level::warning,
                        caption,
                        desc);

                    m_lastCashierAlertTime = now;
                    logCashierDebug("ALERT TRIGGERED: " + caption + " (" + std::to_string(emptySec) + "s)");
                    std::cout << "[Magnet Cashier ALERT] " << caption << " (" << emptySec << "s)" << std::endl;
                }
            }
        }
        else
        {
            if (m_cashierEmptySince != std::chrono::steady_clock::time_point())
            {
                logCashierDebug("Staff detected at cashier desk (" + std::to_string(cashiersInDesk) + " present). Unattended timer reset.");
                m_cashierEmptySince = std::chrono::steady_clock::time_point();
                m_lastCashierAlertTime = std::chrono::steady_clock::time_point();
            }
        }
    }

    // Clean up queue tracks that have exited, tolerating up to 2 seconds of tracking loss
    for (auto it = m_visitorQueueEntryTimes.begin(); it != m_visitorQueueEntryTimes.end();)
    {
        if (activeQueueTrackKeys.find(it->first) == activeQueueTrackKeys.end())
        {
            if (m_visitorQueueLostTimes.find(it->first) == m_visitorQueueLostTimes.end())
            {
                m_visitorQueueLostTimes[it->first] = now;
                ++it;
            }
            else if (std::chrono::duration_cast<std::chrono::seconds>(now - m_visitorQueueLostTimes[it->first]).count() >= 2)
            {
                m_visitorLastAlertTimes.erase(it->first);
                m_visitorQueueLostTimes.erase(it->first);
                it = m_visitorQueueEntryTimes.erase(it);
            }
            else
            {
                ++it;
            }
        }
        else
        {
            ++it;
        }
    }

    // Periodic debug status log every 2 seconds
    if (m_lastPeriodicLogTime == std::chrono::steady_clock::time_point() ||
        std::chrono::duration_cast<std::chrono::seconds>(now - m_lastPeriodicLogTime).count() >= 2)
    {
        m_lastPeriodicLogTime = now;
        const int waitEmptySec = (m_customerWaitingAtEmptyDeskSince != std::chrono::steady_clock::time_point())
            ? static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(now - m_customerWaitingAtEmptyDeskSince).count())
            : 0;
        const int emptySec = (m_cashierEmptySince != std::chrono::steady_clock::time_point())
            ? static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(now - m_cashierEmptySince).count())
            : 0;

        std::ostringstream ss;
        ss << "Status: staff=" << cashiersInDesk << " (debounced=" << staffPresentDebounced << ")"
           << ", queue=" << activeQueueTrackKeys.size() << " (debounced=" << customerPresentDebounced << ")"
           << ", waitEmpty=" << waitEmptySec << "s (urgThresh=" << std::min(waitingSec, unattendedSec) << "s)"
           << ", deskEmpty=" << emptySec << "s (unattThresh=" << unattendedSec << "s)";
        logCashierDebug(ss.str());
    }
}

} // namespace cashier
} // namespace analytics
} // namespace magnet

