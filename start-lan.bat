@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title E-dreikanterbot launcher

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node 20+ first: https://nodejs.org
  pause & exit /b 1
)

if not exist ".env" (
  echo [!] No .env found.
  echo     Copy .env.example to .env and fill DEEPSEEK_API_KEY / KIMI_API_KEY.
  echo.
)

set PORT=8788
if exist ".env" for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
  if /i "%%a"=="PORT" set PORT=%%b
)

echo [+] Starting server on port %PORT% ...
start "E-dreikanterbot" cmd /c "node server.js"

timeout /t 3 >nul

rem ---- LAN address ----
set LANIP=
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  if not defined LANIP set LANIP=%%i
)
set LANIP=%LANIP: =%

echo.
echo ============================================================
echo   Local : http://localhost:%PORT%
if defined LANIP echo   Phone : http://%LANIP%:%PORT%      ^(same Wi-Fi^)
echo ============================================================
echo.

if defined LANIP (
  echo http://%LANIP%:%PORT% | clip
  echo [+] Phone URL copied to clipboard.
)

rem ---- optional public tunnel ----
set CF=%~dp0..\..\toolchain\cloudflared.exe
if not exist "%CF%" set CF=E:\toolchain\cloudflared.exe
if /i "%~1"=="--public" (
  if exist "%CF%" (
    echo [+] Opening public tunnel ^(cloudflared^) ...
    start "cloudflared" cmd /k ""%CF%" tunnel --url http://localhost:%PORT%"
    echo     Copy the https://xxxx.trycloudflare.com URL from the new window.
  ) else (
    echo [!] cloudflared not found at %CF%
  )
) else (
  echo Tip: run "start-lan.bat --public" to expose it to the internet.
)

echo.
start "" "http://localhost:%PORT%"
echo Press any key to close this window ^(server keeps running in its own window^).
pause >nul
