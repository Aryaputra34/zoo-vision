// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier Engine Header

#pragma once

#include "core/base_engine.h"
#include "cashier_device_agent.h"

namespace magnet {
namespace analytics {
namespace cashier {

class CashierEngine: public BaseEngine
{
public:
    CashierEngine();
    virtual ~CashierEngine() override;

protected:
    virtual std::string manifestString() const override;

    virtual void doObtainDeviceAgent(
        nx::sdk::Result<nx::sdk::analytics::IDeviceAgent*>* outResult,
        const nx::sdk::IDeviceInfo* deviceInfo) override;
};

} // namespace cashier
} // namespace analytics
} // namespace magnet
