// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Cashier Integration Implementation

#include "cashier_integration.h"
#include "cashier_engine.h"
#include "cashier_manifest.h"

namespace magnet {
namespace analytics {
namespace cashier {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

CashierIntegration::CashierIntegration()
{
}

CashierIntegration::~CashierIntegration()
{
}

Result<IEngine*> CashierIntegration::doObtainEngine()
{
    return new CashierEngine();
}

std::string CashierIntegration::manifestString() const
{
    return integrationManifest();
}

} // namespace cashier
} // namespace analytics
} // namespace magnet
