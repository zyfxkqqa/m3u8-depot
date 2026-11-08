@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ===== 清空代理变量，强制直连 =====
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
set NO_PROXY=*
set no_proxy=*

REM ===== 本地个性化配置（可选，不纳入版本控制）=====
REM 在 env.local.bat 中可覆盖输出目录、FFmpeg 路径、端口、线程数等
if exist "%~dp0env.local.bat" call "%~dp0env.local.bat"

if not defined M3U8_DOWNLOADER_PORT set "M3U8_DOWNLOADER_PORT=17892"

set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"

if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Please install Node.js 20 or newer.
  echo         Download: https://nodejs.org/
  pause
  exit /b 1
)

echo ========================================
echo   m3u8-depot
echo ========================================
echo Node:   %NODE_EXE%
echo URL:    http://127.0.0.1:%M3U8_DOWNLOADER_PORT%
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:%M3U8_DOWNLOADER_PORT%"

"%NODE_EXE%" "%~dp0server.js"
if errorlevel 1 pause
