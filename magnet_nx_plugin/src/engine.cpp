// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Engine Implementation

#include "engine.h"
#include "device_agent.h"

namespace magnet {
namespace analytics {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

Engine::Engine():
    nx::sdk::analytics::Engine(/*enableOutput*/ true)
{
}

Engine::~Engine()
{
}

void Engine::doObtainDeviceAgent(Result<IDeviceAgent*>* outResult, const IDeviceInfo* deviceInfo)
{
    *outResult = new DeviceAgent(deviceInfo);
}

std::string Engine::manifestString() const
{
    // Request YUV420 uncompressed video frames for high-performance zero-copy inference
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "capabilities": "needUncompressedVideoFrames_yuv420"
}
)json";
}

} // namespace analytics
} // namespace magnet
