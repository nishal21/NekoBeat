$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$cache = "D:\Codesss\cache"
@(
  "$cache\cargo",
  "$cache\go-build",
  "$cache\go-mod",
  "$cache\go",
  "$cache\tmp"
) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

$env:CARGO_HOME = "$cache\cargo"
$env:CARGO_TARGET_DIR = "$root\src-tauri\target"
$env:GOCACHE = "$cache\go-build"
$env:GOMODCACHE = "$cache\go-mod"
$env:GOPATH = "$cache\go"
$env:TMP = "$cache\tmp"
$env:TEMP = "$cache\tmp"
$env:GOTOOLCHAIN = "auto"

Set-Location "$root\src-tauri\sidecars\spotiflac-cli"
$out = "$root\src-tauri\bin\spotiflac-cli.exe"
go build -o $out .
Write-Host "built $out (caches on D:\Codesss\cache)"
