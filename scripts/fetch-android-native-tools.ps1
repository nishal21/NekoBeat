# Fetch yt-dlp + ffmpeg/ffprobe for Android (Windows helper; CI uses the .sh).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $Root "src-tauri\android-sidecars"
$Tmp = Join-Path $Stage "tmp"
New-Item -ItemType Directory -Force -Path $Tmp, (Join-Path $Stage "arm64-v8a") | Out-Null

$FfmpegBase = if ($env:FFMPEG_RELEASE_BASE) { $env:FFMPEG_RELEASE_BASE } else { "https://github.com/spotbye/Dependencies/releases/download/FFmpeg-8.1" }
$YtdlpUrl = if ($env:YTDLP_URL) { $env:YTDLP_URL } else { "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" }

Write-Host "Fetching yt-dlp ..."
curl.exe -L --retry 3 --max-time 1800 -o (Join-Path $Tmp "yt-dlp") $YtdlpUrl
if (-not (Test-Path (Join-Path $Tmp "yt-dlp"))) { throw "yt-dlp download failed" }

Write-Host "Fetching ffmpeg/ffprobe zips ..."
curl.exe -L --retry 3 --max-time 1800 -o (Join-Path $Tmp "ffmpeg-linux-arm64v8.zip") "$FfmpegBase/ffmpeg-linux-arm64v8.zip"
curl.exe -L --retry 3 --max-time 1800 -o (Join-Path $Tmp "ffprobe-linux-arm64v8.zip") "$FfmpegBase/ffprobe-linux-arm64v8.zip"

$ffDir = Join-Path $Tmp "ffmpeg_extract"
$fpDir = Join-Path $Tmp "ffprobe_extract"
Remove-Item -Recurse -Force $ffDir, $fpDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $ffDir, $fpDir | Out-Null
Expand-Archive -Force (Join-Path $Tmp "ffmpeg-linux-arm64v8.zip") $ffDir
Expand-Archive -Force (Join-Path $Tmp "ffprobe-linux-arm64v8.zip") $fpDir

$ffmpeg = Get-ChildItem -Path $ffDir -Recurse -Filter ffmpeg -File | Select-Object -First 1
$ffprobe = Get-ChildItem -Path $fpDir -Recurse -Filter ffprobe -File | Select-Object -First 1
if (-not $ffmpeg -or -not $ffprobe) {
  # Windows Expand-Archive may keep .exe names or nested paths — also try without extension
  $ffmpeg = Get-ChildItem -Path $ffDir -Recurse -File | Where-Object { $_.Name -match '^ffmpeg(\.exe)?$' } | Select-Object -First 1
  $ffprobe = Get-ChildItem -Path $fpDir -Recurse -File | Where-Object { $_.Name -match '^ffprobe(\.exe)?$' } | Select-Object -First 1
}
if (-not $ffmpeg -or -not $ffprobe) { throw "Could not find ffmpeg/ffprobe in zips" }

foreach ($abi in @("arm64-v8a", "armeabi-v7a", "x86_64")) {
  $dest = Join-Path $Stage $abi
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Force (Join-Path $Tmp "yt-dlp") (Join-Path $dest "yt-dlp")
  Copy-Item -Force $ffmpeg.FullName (Join-Path $dest "ffmpeg")
  Copy-Item -Force $ffprobe.FullName (Join-Path $dest "ffprobe")
}

Get-ChildItem (Join-Path $Stage "arm64-v8a") | Format-Table Name, Length
Write-Host "Done. Staged under $Stage"
