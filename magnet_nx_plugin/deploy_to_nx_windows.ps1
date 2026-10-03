# Copyright 2026 Magnet. All rights reserved.
# Deploy Magnet AI Vision Analytics MSVC Plugins (.dll) to local Nx Meta Server

[CmdletBinding()]
param(
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DistDir = Join-Path $ScriptDir "dist_windows"
$NxPluginDir = "C:\Program Files\Network Optix\Nx Meta\MediaServer\plugins"
$NxServiceName = "metavmsMediaServer"

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "Administrator rights required to install plugins into 'C:\Program Files'!"
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" $(if ($Restart) { '-Restart' })"
    exit
}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "🧲 DEPLOYING MAGNET MSVC PLUGINS TO LOCAL NX META MEDIASERVER" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Stop Nx Meta MediaServer to release file locks on DLLs
$Service = Get-Service -Name $NxServiceName -ErrorAction SilentlyContinue
if ($Service -and $Service.Status -eq 'Running') {
    Write-Host "Stopping Windows service '$NxServiceName' to release DLL locks..." -ForegroundColor Yellow
    Stop-Service -Name $NxServiceName -Force -ErrorAction SilentlyContinue
    # Ensure process is completely terminated and files unlocked
    $timeout = 10
    while ((Get-Process -Name "mediaserver" -ErrorAction SilentlyContinue) -and $timeout -gt 0) {
        Start-Sleep -Seconds 1
        $timeout--
    }
    if (Get-Process -Name "mediaserver" -ErrorAction SilentlyContinue) {
        Write-Warning "Forcing termination of residual mediaserver process..."
        Stop-Process -Name "mediaserver" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

# 2. Clean up any loose legacy plugin DLLs in root plugins folder
Write-Host "Cleaning up root plugins folder..." -ForegroundColor Yellow
Remove-Item "$NxPluginDir\magnet_*.dll" -Force -ErrorAction SilentlyContinue
Remove-Item "$NxPluginDir\onnxruntime.dll" -Force -ErrorAction SilentlyContinue
Remove-Item "$NxPluginDir\libwinpthread-1.dll" -Force -ErrorAction SilentlyContinue

# 3. Deploy isolated plugin folders
$PluginFolders = Get-ChildItem -Path $DistDir -Directory
foreach ($folder in $PluginFolders) {
    $targetFolder = Join-Path $NxPluginDir $folder.Name
    Write-Host "Deploying plugin: $($folder.Name) -> $targetFolder" -ForegroundColor Yellow
    if (Test-Path $targetFolder) {
        Remove-Item -Recurse -Force $targetFolder -ErrorAction SilentlyContinue
    }
    Copy-Item $folder.FullName $NxPluginDir -Recurse -Force
}

Write-Host ""
Write-Host "Installed plugins in $NxPluginDir :" -ForegroundColor Green
Get-ChildItem $NxPluginDir | Where-Object { $_.Name -like "*magnet*" } | Select-Object Name

# 4. Start Nx Meta MediaServer
Write-Host ""
Write-Host "Starting Windows service '$NxServiceName'..." -ForegroundColor Yellow
Start-Service -Name $NxServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

$Service = Get-Service -Name $NxServiceName -ErrorAction SilentlyContinue
if ($Service) {
    Write-Host "Service status: $($Service.Status)" -ForegroundColor Green
}

$Port7001 = Get-NetTCPConnection -LocalPort 7001 -ErrorAction SilentlyContinue
if ($Port7001) {
    Write-Host "Nx Meta Server is ONLINE and listening on port 7001!" -ForegroundColor Green
} else {
    Write-Host "Waiting for port 7001 to bind..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "✅ DEPLOYMENT FINISHED!" -ForegroundColor Green
Write-Host "Open Nx Desktop Client -> Camera Settings -> Plugins tab." -ForegroundColor Cyan
Write-Host "You should see:" -ForegroundColor Cyan
Write-Host "  - Magnet: Cashier & Counter Analytics" -ForegroundColor Yellow
Write-Host "  - Magnet AI Vision Analytics (Legacy)" -ForegroundColor Yellow
Write-Host "=================================================================" -ForegroundColor Cyan
