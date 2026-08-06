# One-shot: point Rust/Go caches at D: and free C: build junk.
# Run in PowerShell:  powershell -File scripts/use-d-drive-caches.ps1

$ErrorActionPreference = "Continue"
$cache = "D:\Codesss\cache"
$root = Split-Path $PSScriptRoot -Parent

@(
  "$cache\cargo",
  "$cache\go-build",
  "$cache\go-mod",
  "$cache\go",
  "$cache\tmp",
  "$cache\rustup"
) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

[Environment]::SetEnvironmentVariable("CARGO_HOME", "$cache\cargo", "User")
[Environment]::SetEnvironmentVariable("CARGO_TARGET_DIR", "$root\src-tauri\target", "User")
[Environment]::SetEnvironmentVariable("GOCACHE", "$cache\go-build", "User")
[Environment]::SetEnvironmentVariable("GOMODCACHE", "$cache\go-mod", "User")
[Environment]::SetEnvironmentVariable("GOPATH", "$cache\go", "User")

$temp = Join-Path $env:LOCALAPPDATA "Temp"
@(
  "$temp\cursor-sandbox-cache",
  "$env:LOCALAPPDATA\go-build",
  "$env:USERPROFILE\go\pkg"
) | ForEach-Object {
  if (Test-Path $_) {
    Write-Host "Removing $_"
    Remove-Item $_ -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "C: free: $([math]::Round((Get-PSDrive C).Free/1GB,2)) GB"
Write-Host "Caches -> $cache  |  Rust target -> $root\src-tauri\target"
Write-Host "Open a NEW terminal, then: npm run tauri:dev"
