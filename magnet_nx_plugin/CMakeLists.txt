## Copyright 2026 Magnet. All rights reserved.
## Magnet AI Vision Analytics Plugin - CMake Build Configuration

cmake_minimum_required(VERSION 3.14)
project(magnet_analytics_plugin CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED YES)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Configure standalone build if nxSdkDir is specified and nx_sdk target does not exist yet
if(NOT TARGET nx_sdk)
    set(nxSdkDir "" CACHE PATH "Path to unpacked Server Plugin SDK directory.")
    if(nxSdkDir STREQUAL "")
        # Fallback check if located inside the SDK directory tree
        if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../../src/nx/sdk")
            set(nxSdkDir "${CMAKE_CURRENT_LIST_DIR}/../../..")
        else()
            message(FATAL_ERROR "Please specify -DnxSdkDir=/path/to/server_plugin_sdk")
        endif()
    endif()

    message(STATUS "Using Nx Meta Server Plugin SDK at: ${nxSdkDir}")

    # Set up global compiler and linker options
    if(UNIX)
        string(APPEND CMAKE_SHARED_LINKER_FLAGS " -Wl,--disable-new-dtags")
        set(API_EXPORT_MACRO "__attribute__((visibility(\"default\")))")
    else()
        set(API_EXPORT_MACRO "__declspec(dllexport)")
    endif()

    set(CMAKE_SKIP_BUILD_RPATH ON)
    set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
    set(CMAKE_INSTALL_RPATH "$ORIGIN")

    # 1. Build nx_kit (static library)
    set(nxKitLibraryType "STATIC" CACHE STRING "" FORCE)
    set(nxKitWithTests "OFF" CACHE STRING "" FORCE)
    add_subdirectory(${nxSdkDir}/nx_kit ${CMAKE_CURRENT_BINARY_DIR}/nx_kit)

    # 2. Build nx_sdk (static library)
    set(SDK_SRC_DIR ${nxSdkDir}/src)
    file(GLOB_RECURSE SDK_SRC CONFIGURE_DEPENDS ${SDK_SRC_DIR}/*)
    add_library(nx_sdk STATIC ${SDK_SRC})
    target_include_directories(nx_sdk PUBLIC ${SDK_SRC_DIR})
    target_link_libraries(nx_sdk PUBLIC nx_kit)
    target_compile_definitions(nx_sdk PUBLIC NX_PLUGIN_API=${API_EXPORT_MACRO})
endif()

#--------------------------------------------------------------------------------------------------
# Define Magnet Analytics Plugin Target

set(src_dir ${CMAKE_CURRENT_LIST_DIR}/src)
file(GLOB_RECURSE src_files CONFIGURE_DEPENDS ${src_dir}/*)

# Locate ONNX Runtime C++
set(onnxRuntimeDir "" CACHE PATH "Path to unpacked onnxruntime-linux-x64 directory.")
if(onnxRuntimeDir STREQUAL "")
    if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/onnxruntime-linux-x64")
        set(onnxRuntimeDir "${CMAKE_CURRENT_LIST_DIR}/onnxruntime-linux-x64")
    elseif(EXISTS "${CMAKE_CURRENT_BINARY_DIR}/onnxruntime-linux-x64")
        set(onnxRuntimeDir "${CMAKE_CURRENT_BINARY_DIR}/onnxruntime-linux-x64")
    elseif(EXISTS "$ENV{HOME}/onnxruntime-linux-x64")
        set(onnxRuntimeDir "$ENV{HOME}/onnxruntime-linux-x64")
    endif()
endif()

# Helper static library
add_library(magnet_analytics_plugin_integration STATIC ${src_files})
target_include_directories(magnet_analytics_plugin_integration PUBLIC ${src_dir})
target_link_libraries(magnet_analytics_plugin_integration PUBLIC nx_sdk)

if(NOT onnxRuntimeDir STREQUAL "" AND EXISTS "${onnxRuntimeDir}/include")
    message(STATUS "Using ONNX Runtime at: ${onnxRuntimeDir}")
    target_include_directories(magnet_analytics_plugin_integration PUBLIC "${onnxRuntimeDir}/include")
    find_library(ONNXRUNTIME_LIB onnxruntime PATHS "${onnxRuntimeDir}/lib" REQUIRED)
    target_include_directories(magnet_analytics_plugin_integration PUBLIC "${onnxRuntimeDir}/include")
else()
    message(WARNING "ONNX Runtime directory not specified. Pass -DonnxRuntimeDir=/path/to/onnxruntime-linux-x64")
endif()

# Output shared plugin library: libmagnet_analytics_plugin.so
add_library(magnet_analytics_plugin SHARED "${CMAKE_CURRENT_LIST_DIR}/plugin.cpp")
target_link_libraries(magnet_analytics_plugin PRIVATE magnet_analytics_plugin_integration)

if(ONNXRUNTIME_LIB)
    target_link_libraries(magnet_analytics_plugin PRIVATE ${ONNXRUNTIME_LIB})
endif()

set_target_properties(magnet_analytics_plugin PROPERTIES
    PREFIX "lib"
    OUTPUT_NAME "magnet_analytics_plugin"
)

message(STATUS "Configured Magnet AI Vision Analytics Plugin target: libmagnet_analytics_plugin.so")
