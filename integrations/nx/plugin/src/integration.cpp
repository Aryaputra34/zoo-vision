// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Integration Implementation

#include "integration.h"
#include "engine.h"

namespace magnet {
namespace analytics {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

Integration::Integration()
{
}

Integration::~Integration()
{
}

Result<IEngine*> Integration::doObtainEngine()
{
    return new Engine();
}

/**
 * Manifest defining the plugin identity, branding, and metadata for Nx Meta / MetaVMS.
 */
std::string Integration::manifestString() const
{
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "id": "magnet.analytics",
    "name": "Magnet AI Vision Analytics",
    "description": "Enterprise AI Computer Vision and Video Analytics Plugin by Magnet. Provides automated presence tracking, queue monitoring, occupancy auditing, and gate vehicle counting.",
    "version": "1.0.0",
    "vendor": "Magnet"
}
)json";
}

} // namespace analytics
} // namespace magnet
