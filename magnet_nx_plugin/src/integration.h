// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Integration Header

#pragma once

#include <nx/sdk/analytics/helpers/integration.h>
#include <nx/sdk/analytics/i_engine.h>

namespace magnet {
namespace analytics {

class Integration: public nx::sdk::analytics::Integration
{
public:
    Integration();
    virtual ~Integration() override;

protected:
    virtual nx::sdk::Result<nx::sdk::analytics::IEngine*> doObtainEngine() override;
    virtual std::string manifestString() const override;
};

} // namespace analytics
} // namespace magnet
