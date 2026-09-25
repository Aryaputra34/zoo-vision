// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Engine Header

#pragma once

#include <memory>
#include <nx/sdk/analytics/helpers/engine.h>
#include <nx/sdk/analytics/helpers/integration.h>

#include "yolo_detector.h"

namespace magnet {
namespace analytics {

class Engine: public nx::sdk::analytics::Engine
{
public:
    Engine();
    virtual ~Engine() override;

    std::shared_ptr<YoloDetector> yoloDetector() const { return m_yoloDetector; }

protected:
    virtual std::string manifestString() const override;

    virtual void doObtainDeviceAgent(
        nx::sdk::Result<nx::sdk::analytics::IDeviceAgent*>* outResult,
        const nx::sdk::IDeviceInfo* deviceInfo) override;

private:
    std::string resolveModelPath() const;

private:
    std::shared_ptr<YoloDetector> m_yoloDetector;
};

} // namespace analytics
} // namespace magnet
