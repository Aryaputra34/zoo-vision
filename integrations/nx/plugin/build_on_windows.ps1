# Copyright 2026 Magnet. All rights reserved.
# Magnet AI Vision Analytics - Windows MSVC Build & Package Script

[CmdletBinding()]
param(
    [switch]$Deploy,
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BuildDir = Join-Path $ScriptDir "build_msvc"
$DistDir = Join-Path $ScriptDir "dist_windows"
$NxPluginDir = "C:\Program Files\Network Optix\Nx Meta\MediaServer\plugins"
$NxServiceName = "metavmsMediaServer"

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "🧲 MAGNET AI VISION ANALYTICS - MSVC WINDOWS BUILD & DEPLOY" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Check tools & unpack dependencies if needed
Write-Host "[1/5] Checking MSVC toolchain & dependencies..." -ForegroundColor Yellow
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    throw "cmake not found in PATH! Please install CMake."
}
Write-Host "  Found CMake." -ForegroundColor Green

# Unpack Server Plugin SDK if needed
if (-not (Test-Path "$ScriptDir\server_plugin_sdk\src\nx\sdk")) {
    $sdkZip = Get-ChildItem -Path "$ScriptDir", "$ScriptDir\.." -Filter "*server_plugin_sdk*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sdkZip) {
        Write-Host "  Extracting Server Plugin SDK from $($sdkZip.Name)..." -ForegroundColor Cyan
        Expand-Archive -Path $sdkZip.FullName -DestinationPath $ScriptDir -Force
    }
}

# Unpack Eigen if needed
if (-not (Test-Path "$ScriptDir\eigen")) {
    $eigenZip = Get-ChildItem -Path "$ScriptDir", "$ScriptDir\.." -Filter "eigen-*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($eigenZip) {
        Write-Host "  Extracting Eigen from $($eigenZip.Name)..." -ForegroundColor Cyan
        Expand-Archive -Path $eigenZip.FullName -DestinationPath "$ScriptDir\eigen_temp" -Force
        $innerEigen = Get-ChildItem -Path "$ScriptDir\eigen_temp" -Directory | Where-Object { Test-Path (Join-Path $_.FullName "Eigen") } | Select-Object -First 1
        if ($innerEigen) {
            Move-Item (Join-Path $innerEigen.FullName "Eigen") "$ScriptDir\eigen" -Force
        }
        Remove-Item -Recurse -Force "$ScriptDir\eigen_temp" -ErrorAction SilentlyContinue
    }
}

# Unpack ONNX Runtime if needed
if (-not (Test-Path "$ScriptDir\onnxruntime-win-x64-1.18.0")) {
    $ortZip = Get-ChildItem -Path "$ScriptDir", "$ScriptDir\.." -Filter "onnxruntime-win-x64-*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ortZip) {
        Write-Host "  Extracting ONNX Runtime from $($ortZip.Name)..." -ForegroundColor Cyan
        Expand-Archive -Path $ortZip.FullName -DestinationPath $ScriptDir -Force
    }
}

# 2. Configure with CMake using Visual Studio 2022
Write-Host "[2/5] Configuring CMake with Visual Studio 17 2022..." -ForegroundColor Yellow
cmake -G "Visual Studio 17 2022" -A x64 -B "$BuildDir" -S "$ScriptDir"

# 3. Compile
Write-Host "[3/5] Compiling native DLL targets with MSVC (Release)..." -ForegroundColor Yellow
cmake --build "$BuildDir" --config Release

# 4. Assemble isolated subfolder distribution package
Write-Host "[4/5] Assembling self-contained deployment package..." -ForegroundColor Yellow
if (Test-Path $DistDir) {
    Remove-Item -Recurse -Force $DistDir -ErrorAction SilentlyContinue
}

$CashierDist = Join-Path $DistDir "magnet_cashier_plugin"
$AnalyticsDist = Join-Path $DistDir "magnet_analytics_plugin"

New-Item -ItemType Directory -Force -Path (Join-Path $CashierDist "models") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AnalyticsDist "models") | Out-Null

$OrtDll = Join-Path $ScriptDir "onnxruntime-win-x64-1.18.0\lib\onnxruntime.dll"
$YoloModel = Join-Path $ScriptDir "..\yolo11s.onnx"
if (-not (Test-Path $YoloModel)) {
    $YoloModel = Join-Path $ScriptDir "yolo11s.onnx"
}

# Copy cashier plugin
Copy-Item (Join-Path $BuildDir "plugins\cashier\Release\magnet_cashier_plugin.dll") $CashierDist -Force
Copy-Item $OrtDll $CashierDist -Force
if (Test-Path $YoloModel) {
    Copy-Item $YoloModel (Join-Path $CashierDist "models\yolo11s.onnx") -Force
}

# Copy monolithic analytics plugin
Copy-Item (Join-Path $BuildDir "Release\magnet_analytics_plugin.dll") $AnalyticsDist -Force
Copy-Item $OrtDll $AnalyticsDist -Force
if (Test-Path $YoloModel) {
    Copy-Item $YoloModel (Join-Path $AnalyticsDist "models\yolo11s.onnx") -Force
}

Write-Host "  Successfully packaged into: $DistDir" -ForegroundColor Green
Get-ChildItem -Recurse $DistDir | Select-Object FullName, Length

# 5. Optional Deployment
if ($Deploy) {
    Write-Host "[5/5] Deploying to $NxPluginDir..." -ForegroundColor Yellow
    $IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $IsAdmin) {
        Write-Warning "Deploying to 'C:\Program Files' requires Administrator privileges!"
        Write-Host "Re-launching deployment as Administrator..." -ForegroundColor Yellow
        Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$ScriptDir\deploy_to_nx_windows.ps1`" $(if ($Restart) { '-Restart' })"
    } else {
        & "$ScriptDir\deploy_to_nx_windows.ps1" -Restart:$Restart
    }
} else {
    Write-Host ""
    Write-Host "=================================================================" -ForegroundColor Cyan
    Write-Host "✅ MSVC BUILD COMPLETE!" -ForegroundColor Green
    Write-Host "To deploy the plugins to your local Nx Meta Server:"
    Write-Host "  Right-click 'deploy_to_nx_windows.bat' -> 'Run as administrator'" -ForegroundColor Yellow
    Write-Host "Or run:" -ForegroundColor Yellow
    Write-Host "  .\build_on_windows.ps1 -Deploy -Restart" -ForegroundColor Yellow
    Write-Host "=================================================================" -ForegroundColor Cyan
}
