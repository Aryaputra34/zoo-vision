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
    //
    // Confidence floor 0.1, not the 0.25 the trackers report at: ByteTrack's second association
    // needs the 0.1-0.25 band to keep tracks alive through confidence dips, and the IoU tracker
    // drops anything below 0.25 itself. NMS is class-aware and runs highest-confidence first, so a
    // low-confidence box can never suppress a higher one: every detection >= 0.25 is exactly what
    // a 0.25 floor would have produced.
    m_yoloDetector = std::make_shared<YoloDetector>(modelPath, 640, 640, 0.1f, 0.45f);
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
    // Request YUV420 uncompressed video frames for high-performance zero-copy inference.
    // deviceAgentSettingsModel appears per camera under Camera Settings -> Plugins.
    return /*suppress newline*/ 1 + (const char*) R"json(
{
    "capabilities": "needUncompressedVideoFrames_yuv420",
    "deviceAgentSettingsModel":
    {
        "type": "Settings",
        "items":
        [
            {
                "type": "SwitchButton",
                "name": ")json" + DeviceAgent::kByteTrackSetting + R"json(",
                "caption": "ByteTrack tracking",
                "description": "Track objects with ByteTrack (motion prediction; keeps IDs through fast movement and brief misses) instead of the simple overlap tracker. Changing it restarts tracking on this camera.",
                "defaultValue": false
            }
        ]
    }
}
)json";
}

} // namespace analytics
} // namespace magnet
