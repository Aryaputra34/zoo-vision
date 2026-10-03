# Emergency restore script for Nx Meta Server
$NxPluginDir = "C:\Program Files\Network Optix\Nx Meta\MediaServer\plugins"
$NxServiceName = "metavmsMediaServer"

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "Administrator rights required!"
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`""
    exit
}

Write-Host "Stopping $NxServiceName..." -ForegroundColor Yellow
Stop-Service -Name $NxServiceName -Force -ErrorAction SilentlyContinue

Write-Host "Removing test plugins from $NxPluginDir..." -ForegroundColor Yellow
Remove-Item "$NxPluginDir\magnet_*.dll" -Force -ErrorAction SilentlyContinue
Remove-Item "$NxPluginDir\onnxruntime.dll" -Force -ErrorAction SilentlyContinue
Remove-Item "$NxPluginDir\libwinpthread-1.dll" -Force -ErrorAction SilentlyContinue
Remove-Item "$NxPluginDir\models" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Restarting $NxServiceName..." -ForegroundColor Green
Start-Service -Name $NxServiceName

Start-Sleep -Seconds 3
$Service = Get-Service -Name $NxServiceName
Write-Host "Service Status: $($Service.Status)" -ForegroundColor Green

$Port7001 = Get-NetTCPConnection -LocalPort 7001 -ErrorAction SilentlyContinue
if ($Port7001) {
    Write-Host "SUCCESS: Nx Meta Server is LISTENING on port 7001!" -ForegroundColor Green
} else {
    Write-Host "Waiting for port 7001..." -ForegroundColor Yellow
}
