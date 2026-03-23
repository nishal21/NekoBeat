$gst_root = "C:\Program Files\gstreamer\1.0\msvc_x86_64"
$dest_root = "c:\Users\PC\Music\nekobeat\nekobeat\src-tauri\gstreamer"

if (-not (Test-Path $dest_root)) { New-Item -ItemType Directory -Path $dest_root }
$bin_dest = Join-Path $dest_root "bin"
$plugins_dest = Join-Path $dest_root "plugins"
if (-not (Test-Path $bin_dest)) { New-Item -ItemType Directory -Path $bin_dest }
if (-not (Test-Path $plugins_dest)) { New-Item -ItemType Directory -Path $plugins_dest }

$core_dlls = @(
    "gstreamer-1.0-0.dll", "gstbase-1.0-0.dll", "gstaudio-1.0-0.dll", 
    "gstpbutils-1.0-0.dll", "gsttag-1.0-0.dll", "gstvideo-1.0-0.dll", 
    "gstapp-1.0-0.dll", "gstriff-1.0-0.dll", "gstfft-1.0-0.dll",
    "glib-2.0-0.dll", "gobject-2.0-0.dll", "gmodule-2.0-0.dll", 
    "gthread-2.0-0.dll", "gio-2.0-0.dll", "intl-8.dll",
    "libwinpthread-1.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "z-1.dll",
    "soup-3.0-0.dll", "sqlite3-0.dll", "pcre2-8-0.dll", "libiconv-2.dll", 
    "libcharset-1.dll", "psl-5.dll", "brotlicommon.dll", "brotlidec.dll",
    "xml2-16.dll", "libcrypto-3-x64.dll", "libssl-3-x64.dll",
    "ffi-8.dll", "gstcontroller-1.0-0.dll", "gstnet-1.0-0.dll"
)

$plugins = @(
    "gstcoreelements.dll", "gstplayback.dll", "gsttypefindfunctions.dll",
    "gstaudioconvert.dll", "gstaudioresample.dll", "gstwasapi.dll", "gstdirectsound.dll",
    "gstvolume.dll", "gstequalizer.dll", "gstsoup.dll", "gstisomp4.dll",
    "gstmatroska.dll", "gstdecodebin.dll", "gstvideoconvert.dll", 
    "gstautodetect.dll", "gstapetag.dll", "gstaudioparsers.dll", "gstid3demux.dll"
)

Write-Host "Copying core DLLs..."
foreach ($dll in $core_dlls) {
    Copy-Item (Join-Path $gst_root "bin\$dll") $bin_dest -ErrorAction SilentlyContinue
}

Write-Host "Copying plugins..."
foreach ($plugin in $plugins) {
    Copy-Item (Join-Path $gst_root "lib\gstreamer-1.0\$plugin") $plugins_dest -ErrorAction SilentlyContinue
}

# Copy optional but helpful codec DLLs if they exist
$extra_dlls = @("avcodec-61.dll", "avformat-61.dll", "avutil-59.dll", "swresample-5.dll", "libgstlibav.dll")
foreach ($dll in $extra_dlls) {
    if (Test-Path (Join-Path $gst_root "bin\$dll")) {
        Copy-Item (Join-Path $gst_root "bin\$dll") $bin_dest
    }
    if (Test-Path (Join-Path $gst_root "lib\gstreamer-1.0\$dll")) {
         Copy-Item (Join-Path $gst_root "lib\gstreamer-1.0\$dll") $plugins_dest
    }
}

Write-Host "Done! GStreamer runtime staged at $dest_root"
