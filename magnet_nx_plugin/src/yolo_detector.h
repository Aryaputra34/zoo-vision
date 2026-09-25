// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - ONNX Runtime YOLO Detector Header

#pragma once

#include <string>
#include <vector>
#include <memory>
#include <mutex>

#include <onnxruntime_cxx_api.h>

namespace magnet {
namespace analytics {

struct Detection
{
    float x;          // Normalized left coordinate [0.0 .. 1.0]
    float y;          // Normalized top coordinate [0.0 .. 1.0]
    float width;      // Normalized width [0.0 .. 1.0]
    float height;     // Normalized height [0.0 .. 1.0]
    int classId;      // Class identifier (e.g. 0: person, 2: car, 17: horse)
    float confidence; // Confidence score [0.0 .. 1.0]
};

class YoloDetector
{
public:
    YoloDetector(
        const std::string& modelPath,
        int targetWidth = 1280,
        int targetHeight = 736,
        float confThreshold = 0.25f,
        float nmsThreshold = 0.45f);
    ~YoloDetector();

    bool isLoaded() const;

    /**
     * Runs detection on an uncompressed YUV420 frame (I420 planar).
     * Automatically converts to RGB, performs letterboxing, and executes inference.
     */
    std::vector<Detection> detectFromYuv420(
        const uint8_t* yPlane,
        const uint8_t* uPlane,
        const uint8_t* vPlane,
        int yLineSize,
        int uLineSize,
        int vLineSize,
        int frameWidth,
        int frameHeight);

private:
    void preprocessYuv420(
        const uint8_t* yPlane,
        const uint8_t* uPlane,
        const uint8_t* vPlane,
        int yLineSize,
        int uLineSize,
        int vLineSize,
        int frameWidth,
        int frameHeight,
        std::vector<float>& outTensor,
        float& outScale,
        float& outPadX,
        float& outPadY);

    std::vector<Detection> postprocess(
        const float* outputData,
        size_t numOutputs,
        int numClasses,
        int frameWidth,
        int frameHeight,
        float scale,
        float padX,
        float padY);

    static float calculateIoU(const Detection& a, const Detection& b);

private:
    std::string m_modelPath;
    int m_targetWidth;
    int m_targetHeight;
    float m_confThreshold;
    float m_nmsThreshold;
    bool m_isLoaded = false;

    // ONNX Runtime Core Objects
    Ort::Env m_env;
    Ort::SessionOptions m_sessionOptions;
    std::unique_ptr<Ort::Session> m_session;
    Ort::MemoryInfo m_memoryInfo;

    std::string m_inputName;
    std::string m_outputName;
    std::vector<int64_t> m_inputShape;

    mutable std::mutex m_inferenceMutex;
};

} // namespace analytics
} // namespace magnet
