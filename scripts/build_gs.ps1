# --- GStreamer Sync & Build Script ---

# 1. Define Paths (Using Short Path to avoid Space issues)
$gst_root = "C:\PROGRA~1\gstreamer\1.0\msvc_x86_64"
$target_dir = "$PSScriptRoot\..\src-tauri\gstreamer"

Write-Host "Syncing GStreamer from $gst_root to $target_dir..." -ForegroundColor Cyan

# 2. Re-create the bundled GStreamer folder
if (Test-Path $target_dir) { Remove-Item -Recurse -Force $target_dir }
New-Item -ItemType Directory -Path "$target_dir\bin"
New-Item -ItemType Directory -Path "$target_dir\plugins"
New-Item -ItemType Directory -Path "$target_dir\gio\modules"

# 3. Copy only necessary DLLs, Plugins, and GIO Modules
Copy-Item "$gst_root\bin\*.dll" "$target_dir\bin\" -ErrorAction SilentlyContinue
Copy-Item "$gst_root\lib\gstreamer-1.0\*.dll" "$target_dir\plugins\" -ErrorAction SilentlyContinue
Copy-Item "$gst_root\lib\gio\modules\*.dll" "$target_dir\gio\modules\" -ErrorAction SilentlyContinue

# 4. Set Environment for Build
$env:GSTREAMER_1_0_ROOT_MSVC_X86_64 = "$gst_root\"
$env:PKG_CONFIG_PATH = "$gst_root\lib\pkgconfig"
$env:PATH = "$gst_root\bin;" + $env:PATH

Write-Host "Environment set. Starting Build..." -ForegroundColor Green

# 5. Build Tauri App
cd "$PSScriptRoot\.."
npm run tauri build
