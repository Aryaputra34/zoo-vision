// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Engine Header

#pragma once

#include <nx/sdk/analytics/helpers/engine.h>
#include <nx/sdk/analytics/helpers/integration.h>

namespace magnet {
namespace analytics {

class Engine: public nx::sdk::analytics::Engine
{
public:
    Engine();
    virtual ~Engine() override;

protected:
    virtual std::string manifestString() const override;

    virtual void doObtainDeviceAgent(
        nx::sdk::Result<nx::sdk::analytics::IDeviceAgent*>* outResult,
        const nx::sdk::IDeviceInfo* deviceInfo) override;
};

} // namespace analytics
} // namespace magnet
