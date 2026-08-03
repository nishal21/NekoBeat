# Stage GStreamer runtime into src-tauri/gstreamer for Tauri Windows bundle resources.
# Used by CI after installing the official MSVC MSI to C:\gstreamer.
param(
  [string]$GstRoot = $env:GSTREAMER_1_0_ROOT_MSVC_X86_64,
  [string]$DestRoot = ""
)

$ErrorActionPreference = 'Stop'

if (-not $GstRoot -or -not (Test-Path $GstRoot)) {
  $candidates = @(
    'C:\gstreamer\1.0\msvc_x86_64',
    'C:\Program Files\gstreamer\1.0\msvc_x86_64'
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $GstRoot = $c; break }
  }
}

if (-not $GstRoot -or -not (Test-Path $GstRoot)) {
  throw "GStreamer root not found. Set GSTREAMER_1_0_ROOT_MSVC_X86_64 or install MSVC runtime."
}

if (-not $DestRoot) {
  $DestRoot = Join-Path $PSScriptRoot '..\src-tauri\gstreamer' | Resolve-Path -ErrorAction SilentlyContinue
  if (-not $DestRoot) {
    $DestRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri\gstreamer'
  }
}

$binDest = Join-Path $DestRoot 'bin'
$pluginsDest = Join-Path $DestRoot 'lib\gstreamer-1.0'
New-Item -ItemType Directory -Force -Path $binDest | Out-Null
New-Item -ItemType Directory -Force -Path $pluginsDest | Out-Null

Write-Host "Staging GStreamer from $GstRoot -> $DestRoot"

# Copy runtime bins + plugins needed for playback (keep lean vs full SDK tree)
$binSrc = Join-Path $GstRoot 'bin'
$pluginSrc = Join-Path $GstRoot 'lib\gstreamer-1.0'
if (-not (Test-Path $binSrc)) { throw "Missing $binSrc" }

Get-ChildItem $binSrc -Filter '*.dll' | ForEach-Object {
  Copy-Item $_.FullName $binDest -Force
}
if (Test-Path $pluginSrc) {
  Get-ChildItem $pluginSrc -Filter '*.dll' | ForEach-Object {
    Copy-Item $_.FullName $pluginsDest -Force
  }
}

# Minimal marker so empty check fails loudly if staging broke
$dllCount = (Get-ChildItem $binDest -Filter '*.dll' -ErrorAction SilentlyContinue).Count
if ($dllCount -lt 20) {
  throw "Staged too few DLLs ($dllCount) into $binDest"
}
Write-Host "Staged $dllCount DLLs into gstreamer/bin (+ plugins)"
