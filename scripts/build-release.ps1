# NekoBeat Release Build Script
# Builds a signed MSI/EXE with updater support
# Usage: .\scripts\build-release.ps1

$ErrorActionPreference = "Stop"

# GStreamer paths
$env:PKG_CONFIG_PATH = "C:\Program Files\gstreamer\1.0\msvc_x86_64\lib\pkgconfig"
$env:PATH = "$PSScriptRoot\..\src-tauri\gstreamer\bin;C:\Program Files\gstreamer\1.0\msvc_x86_64\bin;$env:PATH"

# Signing key for updater — read key content into env var
$keyPath = Join-Path $PSScriptRoot "..\.tauri\nekobeat.key"
if (-not (Test-Path $keyPath)) {
    Write-Host "ERROR: Signing key not found at $keyPath" -ForegroundColor Red
    Write-Host "Run: npx @tauri-apps/cli signer generate -w .tauri/nekobeat.key" -ForegroundColor Yellow
    exit 1
}
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" # Add ur Password in it if it has

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  NekoBeat Release Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Read current version from tauri.conf.json
$conf = Get-Content "$PSScriptRoot\..\src-tauri\tauri.conf.json" | ConvertFrom-Json
$version = $conf.version
Write-Host "`nBuilding version: $version" -ForegroundColor Yellow

# Build
Write-Host "`nStarting Tauri build..." -ForegroundColor Green
npx @tauri-apps/cli build 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

# Output locations
$bundlePath = "$PSScriptRoot\..\src-tauri\target\release\bundle"
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nOutputs:" -ForegroundColor Yellow

# Find the MSI and its signature
$msi = Get-ChildItem "$bundlePath\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
$nsis = Get-ChildItem "$bundlePath\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($msi) {
    Write-Host "  MSI:  $($msi.FullName)" -ForegroundColor White
    $msiSig = "$($msi.FullName).sig"
    if (Test-Path $msiSig) {
        Write-Host "  MSI Signature: $msiSig" -ForegroundColor White
    }
}

if ($nsis) {
    Write-Host "  EXE:  $($nsis.FullName)" -ForegroundColor White
    $nsisSig = "$($nsis.FullName).sig"
    if (Test-Path $nsisSig) {
        Write-Host "  EXE Signature: $nsisSig" -ForegroundColor White
    }
}

Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "  1. Upload the MSI/EXE to a public URL (GitHub release, Drive, etc.)" -ForegroundColor White
Write-Host "  2. Run: .\scripts\publish-update.ps1 -DownloadUrl <URL_TO_MSI_OR_EXE>" -ForegroundColor White
Write-Host "  3. This will generate a latest.json to paste into your GitHub Gist" -ForegroundColor White
