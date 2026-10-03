## Copyright 2026 Magnet. All rights reserved.
## Magnet AI Vision Analytics - Core Library CMake

add_library(magnet_core STATIC
    detection.h
    tracker.h
    iou_tracker.h
    iou_tracker.cpp
    byte_track_tracker.h
    byte_track_tracker.cpp
    third_party/bytetrack/BYTETracker.cpp
    third_party/bytetrack/kalmanFilter.cpp
    third_party/bytetrack/lapjv.cpp
    third_party/bytetrack/STrack.cpp
    third_party/bytetrack/utils.cpp
    yolo_detector.h
    yolo_detector.cpp
    geometry_utils.h
    geometry_utils.cpp
    base_engine.h
    base_engine.cpp
    base_device_agent.h
    base_device_agent.cpp
)

target_include_directories(magnet_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/..
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/bytetrack
    ${onnxRuntimeDir}/include
)

target_link_libraries(magnet_core PUBLIC
    nx_sdk
    Eigen3::Eigen
    ${ONNXRUNTIME_LIB}
)

set_target_properties(magnet_core PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
