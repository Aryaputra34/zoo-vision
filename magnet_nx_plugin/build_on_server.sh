#!/usr/bin/env bash
# Copyright 2026 Magnet. All rights reserved.
# Magnet AI Vision Analytics Plugin - Build & Deploy Script for Linux Server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
PLUGIN_TARGET_DIR="/opt/networkoptix-metavms/mediaserver/bin/plugins"
SERVICE_NAME="networkoptix-metavms-mediaserver"

echo "================================================================="
echo "🧲 MAGNET AI VISION ANALYTICS - LINUX BUILD & DEPLOY"
echo "================================================================="

# 1. Check or install build dependencies
echo "[1/5] Checking build dependencies..."
MISSING_PKGS=""
for pkg in cmake g++ make unzip wget tar; do
    if ! command -v "$pkg" >/dev/null 2>&1; then
        MISSING_PKGS="$MISSING_PKGS $pkg"
    fi
done

if [ -n "$MISSING_PKGS" ]; then
    echo "  Installing missing packages:${MISSING_PKGS}..."
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends $MISSING_PKGS
else
    echo "  All build dependencies (cmake, g++, make) are installed."
fi

# 2. Locate Nx Meta Analytics SDK
echo "[2/5] Locating Nx Meta Server Plugin SDK..."
SDK_DIR=""

# Check if SDK path provided via env or argument
if [ -n "${NX_SDK_DIR:-}" ] && [ -d "$NX_SDK_DIR/src/nx/sdk" ]; then
    SDK_DIR="$NX_SDK_DIR"
elif [ $# -ge 1 ] && [ -d "$1/src/nx/sdk" ]; then
    SDK_DIR="$1"
# Check standard candidate directories
elif [ -d "${SCRIPT_DIR}/../server_plugin_sdk/src/nx/sdk" ]; then
    SDK_DIR="$(cd "${SCRIPT_DIR}/../server_plugin_sdk" && pwd)"
elif [ -d "${SCRIPT_DIR}/server_plugin_sdk/src/nx/sdk" ]; then
    SDK_DIR="${SCRIPT_DIR}/server_plugin_sdk"
elif [ -d "$HOME/server_plugin_sdk/src/nx/sdk" ]; then
    SDK_DIR="$HOME/server_plugin_sdk"
fi

# If SDK folder not found, look for universal zip file
if [ -z "$SDK_DIR" ]; then
    ZIP_CANDIDATE=""
    for zip in \
        "${SCRIPT_DIR}/metavms-server_plugin_sdk-6.1.2.42921-universal.zip" \
        "${SCRIPT_DIR}/../metavms-server_plugin_sdk-6.1.2.42921-universal.zip" \
        "$HOME/metavms-server_plugin_sdk-6.1.2.42921-universal.zip" \
        "$HOME/Downloads/metavms-server_plugin_sdk-6.1.2.42921-universal.zip"; do
        if [ -f "$zip" ]; then
            ZIP_CANDIDATE="$zip"
            break
        fi
    done

    if [ -n "$ZIP_CANDIDATE" ]; then
        echo "  Found SDK archive: $ZIP_CANDIDATE"
        echo "  Extracting to ${SCRIPT_DIR}/server_plugin_sdk..."
        mkdir -p "${SCRIPT_DIR}/server_plugin_sdk"
        unzip -q -o "$ZIP_CANDIDATE" -d "${SCRIPT_DIR}/"
        SDK_DIR="${SCRIPT_DIR}/server_plugin_sdk"
    else
        echo "ERROR: Nx Meta Plugin SDK not found!"
        echo "Please provide the SDK path or copy the SDK zip to this directory:"
        echo "  Usage: ./build_on_server.sh /path/to/server_plugin_sdk"
        echo "  Or place 'metavms-server_plugin_sdk-6.1.2.42921-universal.zip' next to this script."
        exit 1
    fi
fi

# 3. Locate or download ONNX Runtime C++ Linux x64
echo "[3/6] Locating ONNX Runtime C++ Linux x64 library..."
ORT_DIR="${SCRIPT_DIR}/onnxruntime-linux-x64"

if [ ! -d "$ORT_DIR/include" ]; then
    ORT_TGZ="${SCRIPT_DIR}/onnxruntime-linux-x64-1.18.0.tgz"
    if [ ! -f "$ORT_TGZ" ]; then
        echo "  Downloading prebuilt ONNX Runtime C++ v1.18.0 for Linux x64..."
        wget -q --show-progress "https://github.com/microsoft/onnxruntime/releases/download/v1.18.0/onnxruntime-linux-x64-1.18.0.tgz" -O "$ORT_TGZ"
    fi

    echo "  Extracting ONNX Runtime..."
    tar -xzf "$ORT_TGZ" -C "${SCRIPT_DIR}/"
    EXTRACTED_DIR=$(find "${SCRIPT_DIR}" -maxdepth 1 -type d -name "onnxruntime-linux-x64-*" | head -n 1)
    if [ -n "$EXTRACTED_DIR" ]; then
        mv "$EXTRACTED_DIR" "$ORT_DIR"
    fi
fi

if [ -d "$ORT_DIR/include" ]; then
    echo "  ONNX Runtime ready at: $ORT_DIR"
else
    echo "ERROR: Failed to prepare ONNX Runtime directory: $ORT_DIR"
    exit 1
fi

# 4. Configure and compile using CMake
echo "[4/6] Configuring and building libmagnet_analytics_plugin.so..."
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

cmake -DnxSdkDir="$SDK_DIR" -DonnxRuntimeDir="$ORT_DIR" -DCMAKE_BUILD_TYPE=Release ..
make -j"$(nproc)"

SO_FILE="${BUILD_DIR}/libmagnet_analytics_plugin.so"
if [ ! -f "$SO_FILE" ]; then
    echo "ERROR: Compilation finished but $SO_FILE was not found!"
    exit 1
fi

echo "  Build successful! Binary: $SO_FILE ($(du -h "$SO_FILE" | cut -f1))"

# 5. Deploy plugin and ONNX Runtime libraries to MetaVMS Mediaserver
echo "[5/6] Deploying plugin and runtime libraries to MetaVMS server..."
sudo mkdir -p "$PLUGIN_TARGET_DIR"
sudo mkdir -p "${PLUGIN_TARGET_DIR}/models"

sudo cp -f "$SO_FILE" "$PLUGIN_TARGET_DIR/"
sudo chmod 755 "${PLUGIN_TARGET_DIR}/libmagnet_analytics_plugin.so"

# Copy libonnxruntime.so alongside the plugin
sudo cp -P -f "$ORT_DIR"/lib/libonnxruntime.so* "$PLUGIN_TARGET_DIR/" || true

# Copy model files if present in the workspace
for model in \
    "${SCRIPT_DIR}/yolo11m.onnx" \
    "${SCRIPT_DIR}/../yolo11m.onnx" \
    "${SCRIPT_DIR}/models/yolo11m.onnx" \
    "${SCRIPT_DIR}/../models/yolo11m.onnx" \
    "${SCRIPT_DIR}/yolo11s.onnx" \
    "${SCRIPT_DIR}/../yolo11s.onnx"; do
    if [ -f "$model" ]; then
        echo "  Deploying model: $(basename "$model") -> ${PLUGIN_TARGET_DIR}/models/"
        sudo cp -f "$model" "${PLUGIN_TARGET_DIR}/models/"
        break
    fi
done

# 6. Restart MetaVMS service
echo "[6/6] Restarting ${SERVICE_NAME}..."
if systemctl list-unit-files | grep -q "${SERVICE_NAME}"; then
    sudo systemctl restart "${SERVICE_NAME}"
    echo "  Service restarted successfully."
    echo ""
    echo "Checking service status:"
    sudo systemctl --no-pager status "${SERVICE_NAME}" | head -n 12 || true
else
    echo "  Warning: ${SERVICE_NAME} not found in systemd. If running under a different name, restart manually."
fi

echo ""
echo "================================================================="
echo "✅ DEPLOYMENT COMPLETE!"
echo "Open Nx Desktop Client -> Camera Settings -> Plugins tab."
echo "You will see: 'Magnet AI Vision Analytics' by Magnet"
echo "================================================================="
