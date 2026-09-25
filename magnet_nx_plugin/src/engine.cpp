#include "engine.h"
#include "device_agent.h"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <vector>

namespace magnet {
namespace analytics {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

Engine::Engine():
    nx::sdk::analytics::Engine(/*enableOutput*/ true)
{
    const std::string modelPath = resolveModelPath();
    std::cout << "[Magnet AI Engine] Selected ONNX model path: " << modelPath << std::endl;
    // Target resolution: 640x640 for fast inference. Dynamic ONNX input accepts any resolution.
    // Using 640x640 instead of 1280x736 reduces pixel count ~4x, preventing frame queue overflow.
    m_yoloDetector = std::make_shared<YoloDetector>(modelPath, 640, 640, 0.25f, 0.45f);
}

Engine::~Engine()
{
}

std::string Engine::resolveModelPath() const
{
    const char* envPath = std::getenv("MAGNET_MODEL_PATH");
    if (envPath)
    {
        std::ifstream testFile(envPath);
        if (testFile.good())
        {
            return envPath;
        }
    }

    const std::vector<std::string> candidatePaths = {
        "/opt/networkoptix-metavms/mediaserver/bin/models/yolo11m.onnx",
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/models/yolo11m.onnx",
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/yolo11m.onnx",
        "/opt/networkoptix-metavms/mediaserver/bin/models/yolo11s.onnx",
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/models/yolo11s.onnx",
        "models/yolo11m.onnx",
        "yolo11m.onnx",
        "../models/yolo11m.onnx"
    };

    for (const auto& path : candidatePaths)
    {
        std::ifstream testFile(path);
        if (testFile.good())
        {
            return path;
        }
    }

    return candidatePaths.front();
}

void Engine::doObtainDeviceAgent(Result<IDeviceAgent*>* outResult, const IDeviceInfo* deviceInfo)
{
    *outResult = new DeviceAgent(deviceInfo, m_yoloDetector);
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
