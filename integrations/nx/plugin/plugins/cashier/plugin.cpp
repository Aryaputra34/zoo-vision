// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Cashier Plugin Entry Point

#include "cashier_integration.h"

/**
 * Called by the Network Optix Mediaserver daemon to instantiate the Cashier Integration.
 * Requires C linkage without C++ name mangling in the dynamic library export table.
 */
extern "C" NX_PLUGIN_API nx::sdk::IIntegration* createNxPlugin()
{
    return new magnet::analytics::cashier::CashierIntegration();
}
