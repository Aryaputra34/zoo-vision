// Copyright 2026 Magnet. All rights reserved.
// Magnet AI Vision Analytics - Detection Record

#pragma once

namespace magnet {
namespace analytics {

/// One detector output box. Kept apart from yolo_detector.h so the trackers do not depend on
/// ONNX Runtime.
struct Detection
{
    float x;          // Normalized left coordinate [0.0 .. 1.0]
    float y;          // Normalized top coordinate [0.0 .. 1.0]
    float width;      // Normalized width [0.0 .. 1.0]
    float height;     // Normalized height [0.0 .. 1.0]
    int classId;      // Class identifier (e.g. 0: person, 2: car, 17: horse)
    float confidence; // Confidence score [0.0 .. 1.0]
};

} // namespace analytics
} // namespace magnet
