// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Base Engine Implementation

#include "base_engine.h"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <vector>

namespace magnet {
namespace analytics {

BaseEngine::BaseEngine(
    const std::string& preferredModelName,
    int inputWidth,
    int inputHeight,
    float confThreshold,
    float nmsThreshold):
    nx::sdk::analytics::Engine(/*enableOutput*/ true)
{
    const std::string modelPath = resolveModelPath(preferredModelName);
    std::cout << "[Magnet AI Engine] Selected ONNX model path: " << modelPath << std::endl;
    m_yoloDetector = std::make_shared<YoloDetector>(
        modelPath, inputWidth, inputHeight, confThreshold, nmsThreshold);
}

BaseEngine::~BaseEngine()
{
}

std::string BaseEngine::resolveModelPath(const std::string& preferredModelName) const
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
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/magnet_cashier_plugin/models/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/magnet_analytics_plugin/models/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/magnet_cashier_plugin/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/magnet_analytics_plugin/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/models/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/models/" + preferredModelName,
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/models/" + preferredModelName,
        "/opt/networkoptix-metavms/mediaserver/bin/models/" + preferredModelName,
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/" + preferredModelName,
        "models/" + preferredModelName,
        preferredModelName,
        "../models/" + preferredModelName,
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/magnet_cashier_plugin/models/yolo11s.onnx",
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/magnet_analytics_plugin/models/yolo11s.onnx",
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/models/yolo11s.onnx",
        "C:/Program Files/Network Optix/Nx Meta/MediaServer/plugins/models/yolo11m.onnx",
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/models/yolo11s.onnx",
        "/opt/networkoptix-metavms/mediaserver/bin/plugins/models/yolo11m.onnx",
        "models/yolo11s.onnx",
        "models/yolo11m.onnx",
        "yolo11s.onnx",
        "yolo11m.onnx"
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

} // namespace analytics
} // namespace magnet
