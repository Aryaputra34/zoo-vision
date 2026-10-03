@echo off
:: Copyright 2026 Magnet. All rights reserved.
:: 1-Click Deploy for Magnet Nx Meta Plugins (.dll) on Windows

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [UAC] Requesting Administrator permissions...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy_to_nx_windows.ps1" -Restart
pause
