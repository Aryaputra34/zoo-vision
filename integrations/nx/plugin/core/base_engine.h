// Copyright 2026 Magnet. All rights reserved.
// Network Optix MetaVMS Analytics Plugin - Base Engine Header

#pragma once

#include <memory>
#include <string>
#include <vector>
#include <nx/sdk/analytics/helpers/engine.h>

#include "yolo_detector.h"

namespace magnet {
namespace analytics {

/**
 * Base class for use-case engines.
 * Manages model resolution and YOLO ONNX runtime detector initialization.
 */
class BaseEngine: public nx::sdk::analytics::Engine
{
public:
    explicit BaseEngine(
        const std::string& preferredModelName = "yolo11s.onnx",
        int inputWidth = 640,
        int inputHeight = 640,
        float confThreshold = 0.1f,
        float nmsThreshold = 0.45f);

    virtual ~BaseEngine() override;

    std::shared_ptr<YoloDetector> yoloDetector() const { return m_yoloDetector; }

protected:
    std::string resolveModelPath(const std::string& preferredModelName) const;

protected:
    std::shared_ptr<YoloDetector> m_yoloDetector;
};

} // namespace analytics
} // namespace magnet
