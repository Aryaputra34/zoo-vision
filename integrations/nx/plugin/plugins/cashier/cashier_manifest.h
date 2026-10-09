// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier & Counter Plugin Manifest Header

#pragma once

#include <string>

namespace magnet {
namespace analytics {
namespace cashier {

inline std::string integrationManifest()
{
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "id": "magnet.analytics.cashier",
    "name": "Magnet: Cashier & Counter Analytics",
    "description": "Monitors cashier desk occupancy, unstaffed alert timers, and customer queue waiting times by Magnet.",
    "version": "1.0.0",
    "vendor": "Magnet"
}
)json";
}

inline std::string engineManifest()
{
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "capabilities": "needUncompressedVideoFrames_yuv420",
    "deviceAgentSettingsModel":
    {
        "type": "Settings",
        "items":
        [
            {
                "type": "PolygonFigure",
                "name": "cashierZone",
                "caption": "Cashier Desk Staff Area (Polygon)",
                "description": "Draw polygon area for the cashier staff workspace.",
                "useLabelField": false,
                "useDisplayOnCamera": true
            },
            {
                "type": "PolygonFigure",
                "name": "queueZone",
                "caption": "Customer Waiting Queue Area (Polygon)",
                "description": "Draw polygon area for the customer waiting queue line.",
                "useLabelField": false,
                "useDisplayOnCamera": true
            },
            {
                "type": "SpinBox",
                "name": "unattendedThresholdSec",
                "caption": "Unattended Alert Delay (seconds)",
                "defaultValue": 10,
                "minValue": 1,
                "maxValue": 300
            },
            {
                "type": "SpinBox",
                "name": "waitingThresholdSec",
                "caption": "Customer Waiting Alert Delay (seconds)",
                "defaultValue": 10,
                "minValue": 1,
                "maxValue": 300
            },
            {
                "type": "SwitchButton",
                "name": "useByteTrack",
                "caption": "ByteTrack Tracking",
                "description": "Track persons with ByteTrack to maintain IDs through occlusions.",
                "defaultValue": true
            }
        ]
    }
}
)json";
}

inline std::string deviceAgentManifest()
{
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "supportedTypes":
    [
        { "objectTypeId": "magnet.person.cashier" },
        { "objectTypeId": "magnet.person.visitor" },
        { "eventTypeId": "magnet.event.cashier_unattended" },
        { "eventTypeId": "magnet.event.visitor_unserved" }
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
                "name": "Magnet: Queue Visitor",
                "base": "nx.base.Person"
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
            }
        ]
    }
}
)json";
}

} // namespace cashier
} // namespace analytics
} // namespace magnet
