// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - ONNX Runtime YOLO Detector Implementation

#include "yolo_detector.h"

#include <iostream>
#include <algorithm>
#include <cmath>

namespace magnet {
namespace analytics {

YoloDetector::YoloDetector(
    const std::string& modelPath,
    int targetWidth,
    int targetHeight,
    float confThreshold,
    float nmsThreshold):
    m_modelPath(modelPath),
    m_targetWidth(targetWidth),
    m_targetHeight(targetHeight),
    m_confThreshold(confThreshold),
    m_nmsThreshold(nmsThreshold),
    m_env(ORT_LOGGING_LEVEL_WARNING, "MagnetYolo"),
    m_memoryInfo(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault))
{
    try
    {
        m_sessionOptions.SetIntraOpNumThreads(2);
        m_sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

        std::cout << "[Magnet AI] Loading ONNX model: " << m_modelPath << "..." << std::endl;
        m_session = std::make_unique<Ort::Session>(m_env, m_modelPath.c_str(), m_sessionOptions);

        Ort::AllocatorWithDefaultOptions allocator;
        auto inNameAlloc = m_session->GetInputNameAllocated(0, allocator);
        m_inputName = inNameAlloc.get();

        auto outNameAlloc = m_session->GetOutputNameAllocated(0, allocator);
        m_outputName = outNameAlloc.get();

        m_inputShape = {1, 3, m_targetHeight, m_targetWidth};
        m_isLoaded = true;

        std::cout << "[Magnet AI] Successfully loaded model! Input: " << m_inputName
                  << " [" << m_inputShape[0] << ", " << m_inputShape[1] << ", "
                  << m_inputShape[2] << ", " << m_inputShape[3] << "]"
                  << ", Output: " << m_outputName << std::endl;
    }
    catch (const std::exception& e)
    {
        std::cerr << "[Magnet AI] ERROR: Failed to load ONNX model '" << modelPath
                  << "': " << e.what() << std::endl;
        m_isLoaded = false;
    }
}

YoloDetector::~YoloDetector()
{
}

bool YoloDetector::isLoaded() const
{
    return m_isLoaded;
}

void YoloDetector::preprocessYuv420(
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
    float& outPadY)
{
    outScale = std::min(
        static_cast<float>(m_targetWidth) / static_cast<float>(frameWidth),
        static_cast<float>(m_targetHeight) / static_cast<float>(frameHeight));

    const int newW = static_cast<int>(frameWidth * outScale);
    const int newH = static_cast<int>(frameHeight * outScale);
    outPadX = (m_targetWidth - newW) / 2.0f;
    outPadY = (m_targetHeight - newH) / 2.0f;

    const size_t planeSize = m_targetWidth * m_targetHeight;
    outTensor.assign(3 * planeSize, 114.0f / 255.0f); // Standard YOLO letterbox padding

    const int startX = static_cast<int>(outPadX);
    const int startY = static_cast<int>(outPadY);

    for (int y = 0; y < newH; ++y)
    {
        const int srcY = std::min(frameHeight - 1, static_cast<int>(y / outScale));
        const int dstY = startY + y;
        const int uvSrcY = srcY / 2;

        for (int x = 0; x < newW; ++x)
        {
            const int srcX = std::min(frameWidth - 1, static_cast<int>(x / outScale));
            const int dstX = startX + x;
            const int uvSrcX = srcX / 2;

            const float Y = static_cast<float>(yPlane[srcY * yLineSize + srcX]);
            const float U = static_cast<float>(uPlane[uvSrcY * uLineSize + uvSrcX]);
            const float V = static_cast<float>(vPlane[uvSrcY * vLineSize + uvSrcX]);

            // YUV (BT.601) to RGB conversion
            float R = Y + 1.402f * (V - 128.0f);
            float G = Y - 0.344136f * (U - 128.0f) - 0.714136f * (V - 128.0f);
            float B = Y + 1.772f * (U - 128.0f);

            R = std::max(0.0f, std::min(255.0f, R)) / 255.0f;
            G = std::max(0.0f, std::min(255.0f, G)) / 255.0f;
            B = std::max(0.0f, std::min(255.0f, B)) / 255.0f;

            const size_t pixelIdx = dstY * m_targetWidth + dstX;
            outTensor[0 * planeSize + pixelIdx] = R;
            outTensor[1 * planeSize + pixelIdx] = G;
            outTensor[2 * planeSize + pixelIdx] = B;
        }
    }
}

std::vector<Detection> YoloDetector::detectFromYuv420(
    const uint8_t* yPlane,
    const uint8_t* uPlane,
    const uint8_t* vPlane,
    int yLineSize,
    int uLineSize,
    int vLineSize,
    int frameWidth,
    int frameHeight)
{
    if (!m_isLoaded || !m_session)
    {
        return {};
    }

    std::vector<float> inputData;
    float scale = 1.0f;
    float padX = 0.0f;
    float padY = 0.0f;

    preprocessYuv420(
        yPlane, uPlane, vPlane,
        yLineSize, uLineSize, vLineSize,
        frameWidth, frameHeight,
        inputData, scale, padX, padY);

    Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
        m_memoryInfo,
        inputData.data(),
        inputData.size(),
        m_inputShape.data(),
        m_inputShape.size());

    const char* inputNames[] = {m_inputName.c_str()};
    const char* outputNames[] = {m_outputName.c_str()};

    std::vector<Ort::Value> outputTensors;
    {
        std::lock_guard<std::mutex> lock(m_inferenceMutex);
        outputTensors = m_session->Run(
            Ort::RunOptions{nullptr},
            inputNames,
            &inputTensor,
            1,
            outputNames,
            1);
    }

    if (outputTensors.empty())
    {
        return {};
    }

    const float* outputData = outputTensors.front().GetTensorData<float>();
    const auto shape = outputTensors.front().GetTensorTypeAndShapeInfo().GetShape();

    // Shape is [1, 84, N] in YOLOv8 / YOLOv11 / YOLO26
    const int numChannels = static_cast<int>(shape[1]);
    const size_t numOutputs = static_cast<size_t>(shape[2]);
    const int numClasses = numChannels - 4;

    return postprocess(outputData, numOutputs, numClasses, frameWidth, frameHeight, scale, padX, padY);
}

std::vector<Detection> YoloDetector::postprocess(
    const float* outputData,
    size_t numOutputs,
    int numClasses,
    int frameWidth,
    int frameHeight,
    float scale,
    float padX,
    float padY)
{
    std::vector<Detection> candidates;
    candidates.reserve(128);

    for (size_t i = 0; i < numOutputs; ++i)
    {
        // 1. Identify highest scoring class
        float maxScore = 0.0f;
        int bestClass = -1;

        for (int c = 0; c < numClasses; ++c)
        {
            const float score = outputData[(4 + c) * numOutputs + i];
            if (score > maxScore)
            {
                maxScore = score;
                bestClass = c;
            }
        }

        if (maxScore < m_confThreshold)
        {
            continue;
        }

        // 2. Decode bounding box coordinates [cx, cy, w, h]
        const float cx = outputData[0 * numOutputs + i];
        const float cy = outputData[1 * numOutputs + i];
        const float w = outputData[2 * numOutputs + i];
        const float h = outputData[3 * numOutputs + i];

        // 3. Remove letterbox padding and scale back to original resolution
        const float origX = (cx - w / 2.0f - padX) / scale;
        const float origY = (cy - h / 2.0f - padY) / scale;
        const float origW = w / scale;
        const float origH = h / scale;

        // 4. Normalize to [0.0 .. 1.0] for Nx Meta Client
        Detection det;
        det.x = std::max(0.0f, std::min(1.0f, origX / static_cast<float>(frameWidth)));
        det.y = std::max(0.0f, std::min(1.0f, origY / static_cast<float>(frameHeight)));
        det.width = std::max(0.0f, std::min(1.0f - det.x, origW / static_cast<float>(frameWidth)));
        det.height = std::max(0.0f, std::min(1.0f - det.y, origH / static_cast<float>(frameHeight)));
        det.classId = bestClass;
        det.confidence = maxScore;

        candidates.push_back(det);
    }

    // 5. Non-Maximum Suppression (NMS)
    std::sort(candidates.begin(), candidates.end(), [](const Detection& a, const Detection& b) {
        return a.confidence > b.confidence;
    });

    std::vector<Detection> results;
    std::vector<bool> suppressed(candidates.size(), false);

    for (size_t i = 0; i < candidates.size(); ++i)
    {
        if (suppressed[i])
        {
            continue;
        }

        results.push_back(candidates[i]);

        for (size_t j = i + 1; j < candidates.size(); ++j)
        {
            if (suppressed[j])
            {
                continue;
            }

            // Only suppress candidates of the same class
            if (candidates[i].classId == candidates[j].classId)
            {
                if (calculateIoU(candidates[i], candidates[j]) > m_nmsThreshold)
                {
                    suppressed[j] = true;
                }
            }
        }
    }

    return results;
}

float YoloDetector::calculateIoU(const Detection& a, const Detection& b)
{
    const float x1 = std::max(a.x, b.x);
    const float y1 = std::max(a.y, b.y);
    const float x2 = std::min(a.x + a.width, b.x + b.width);
    const float y2 = std::min(a.y + a.height, b.y + b.height);

    const float interWidth = std::max(0.0f, x2 - x1);
    const float interHeight = std::max(0.0f, y2 - y1);
    const float intersection = interWidth * interHeight;

    const float areaA = a.width * a.height;
    const float areaB = b.width * b.height;
    const float unionArea = areaA + areaB - intersection;

    return (unionArea <= 0.0f) ? 0.0f : (intersection / unionArea);
}

} // namespace analytics
} // namespace magnet
