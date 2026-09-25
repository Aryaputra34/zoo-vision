// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Entry Point

#include "src/integration.h"

/**
 * Called by the Network Optix Mediaserver daemon to instantiate the Integration.
 * Requires C linkage without C++ name mangling in the dynamic library export table.
 *
 * NX_PLUGIN_API defines the export attribute:
 *   - Linux: __attribute__((visibility("default")))
 *   - Windows: __declspec(dllexport)
 */
extern "C" NX_PLUGIN_API nx::sdk::IIntegration* createNxPlugin()
{
    return new magnet::analytics::Integration();
}
