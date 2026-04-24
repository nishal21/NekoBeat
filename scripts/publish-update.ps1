# NekoBeat Publish Update Script
# Generates latest.json for the GitHub Gist updater endpoint
#
# Usage: .\scripts\publish-update.ps1 -DownloadUrl "https://github.com/nishal21/NekoBeat/releases/download/v0.2.0/NekoBeat_0.2.0_x64-setup.exe"
#
# The script reads the .sig file from your last build and generates latest.json.
# Copy the contents of latest.json into your GitHub Gist.

param(
    [Parameter(Mandatory=$true)]
    [string]$DownloadUrl,
    
    [string]$Notes = ""
)

$ErrorActionPreference = "Stop"

# Read version from tauri.conf.json
$conf = Get-Content "$PSScriptRoot\..\src-tauri\tauri.conf.json" | ConvertFrom-Json
$version = $conf.version

$bundlePath = "$PSScriptRoot\..\src-tauri\target\release\bundle"

# Determine which installer was built and find its signature
$signature = $null
$platform = "windows-x86_64"

# Check NSIS exe first (preferred for updater)
$nsis = Get-ChildItem "$bundlePath\nsis\*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($nsis) {
    $sigFile = "$($nsis.FullName).sig"
    if (Test-Path $sigFile) {
        $signature = Get-Content $sigFile -Raw
        $signature = $signature.Trim()
        Write-Host "Using NSIS installer signature" -ForegroundColor Green
    }
}

# Fallback to MSI
if (-not $signature) {
    $msi = Get-ChildItem "$bundlePath\msi\*.msi" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($msi) {
        $sigFile = "$($msi.FullName).sig"
        if (Test-Path $sigFile) {
            $signature = Get-Content $sigFile -Raw
            $signature = $signature.Trim()
            Write-Host "Using MSI installer signature" -ForegroundColor Green
        }
    }
}

if (-not $signature) {
    Write-Host "ERROR: No .sig file found. Did you run build-release.ps1 first?" -ForegroundColor Red
    exit 1
}

$date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

if (-not $Notes) {
    $Notes = "NekoBeat v$version"
}

# Build latest.json
$json = @{
    version = "v$version"
    notes = $Notes
    pub_date = $date
    platforms = @{
        $platform = @{
            signature = $signature
            url = $DownloadUrl
        }
    }
} | ConvertTo-Json -Depth 4

$outputPath = "$PSScriptRoot\..\latest.json"
$json | Out-File -FilePath $outputPath -Encoding utf8

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  latest.json Generated!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nVersion: v$version" -ForegroundColor Yellow
Write-Host "Date: $date" -ForegroundColor Yellow
Write-Host "URL: $DownloadUrl" -ForegroundColor Yellow
Write-Host "`nFile saved to: $outputPath" -ForegroundColor White
Write-Host "`n--- Copy the contents below into your GitHub Gist ---" -ForegroundColor Cyan
Write-Host $json -ForegroundColor White
Write-Host "--- End of latest.json ---`n" -ForegroundColor Cyan

Write-Host "Steps:" -ForegroundColor Yellow
Write-Host "  1. Go to https://gist.github.com" -ForegroundColor White
Write-Host "  2. Create/update a Gist named 'latest.json' with the content above" -ForegroundColor White
Write-Host "  3. Copy the raw URL and put it in tauri.conf.json -> plugins.updater.endpoints" -ForegroundColor White
