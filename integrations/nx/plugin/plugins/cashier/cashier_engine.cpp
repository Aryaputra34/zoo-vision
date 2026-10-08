// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier Engine Implementation

#include "cashier_engine.h"
#include "cashier_manifest.h"

namespace magnet {
namespace analytics {
namespace cashier {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

CashierEngine::CashierEngine():
    BaseEngine("yolo11s.onnx", 640, 640, 0.1f, 0.45f)
{
}

CashierEngine::~CashierEngine()
{
}

std::string CashierEngine::manifestString() const
{
    return engineManifest();
}

void CashierEngine::doObtainDeviceAgent(
    Result<IDeviceAgent*>* outResult,
    const IDeviceInfo* deviceInfo)
{
    *outResult = new CashierDeviceAgent(deviceInfo, m_yoloDetector);
}

} // namespace cashier
} // namespace analytics
} // namespace magnet
