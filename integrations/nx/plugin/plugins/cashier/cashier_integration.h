// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier Integration Header

#pragma once

#include <nx/sdk/analytics/helpers/integration.h>
#include <nx/sdk/analytics/i_engine.h>

namespace magnet {
namespace analytics {
namespace cashier {

class CashierIntegration: public nx::sdk::analytics::Integration
{
public:
    CashierIntegration();
    virtual ~CashierIntegration() override;

protected:
    virtual nx::sdk::Result<nx::sdk::analytics::IEngine*> doObtainEngine() override;
    virtual std::string manifestString() const override;
};

} // namespace cashier
} // namespace analytics
} // namespace magnet
