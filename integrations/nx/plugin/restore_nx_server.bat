@echo off
:: Copyright 2026 Magnet. All rights reserved.
:: Emergency restore for Nx Meta Server

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [UAC] Requesting Administrator permissions...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore_nx_server.ps1"
pause
