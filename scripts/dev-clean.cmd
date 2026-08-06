@echo off
cd /d "%~dp0.."
taskkill /F /IM nekobeat.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1420 "') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":1421 "') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul
call npm run tauri:dev
