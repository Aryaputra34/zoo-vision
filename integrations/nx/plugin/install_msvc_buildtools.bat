@echo off
:: Copyright 2026 Magnet. All rights reserved.
:: Automated Installer for Visual Studio 2022 C++ Build Tools (MSVC cl.exe)

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [UAC] Requesting Administrator permissions...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo =================================================================
echo Installing Visual Studio 2022 C++ Build Tools (MSVC)
echo Workload: Desktop development with C++ (VCTools + Windows SDK)
echo This may take 5-10 minutes depending on your internet connection...
echo =================================================================

winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

echo.
echo =================================================================
echo Installation completed! Press any key to exit.
echo =================================================================
pause
