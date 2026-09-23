@echo off
title Job Jet - LinkedIn Auto Apply
color 0A

cd /d "%~dp0"

echo.
echo   ==================================================
echo             JOB JET - LinkedIn Auto Apply
echo   ==================================================
echo.

REM 1. Verify Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% equ 0 goto :node_ok

color 0C
echo   [ERROR] Node.js is not installed on this computer!
echo.
echo   Please download and install Node.js (version 20 or higher) from:
echo   https://nodejs.org
echo.
echo   After installing Node.js, restart your computer and run this file again.
echo.
pause
exit /b 1

:node_ok
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo   Node.js version: %NODE_VER%
echo   Working directory: %cd%
echo.

REM 2. Free any stuck processes on ports 3001 or 5173
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001,5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul

REM 3. Install backend dependencies if missing
if exist "node_modules\" goto :backend_ok
echo   [SETUP] Installing backend dependencies...
echo   This may take a minute on first run.
echo.
call npm install
if %ERRORLEVEL% equ 0 goto :backend_ok
color 0C
echo.
echo   [ERROR] Failed to install backend dependencies.
pause
exit /b 1

:backend_ok

REM 4. Install frontend dependencies if missing
if exist "ui\node_modules\" goto :frontend_ok
echo   [SETUP] Installing frontend dependencies...
echo.
cd ui
call npm install
cd ..
if %ERRORLEVEL% equ 0 goto :frontend_ok
color 0C
echo.
echo   [ERROR] Failed to install frontend dependencies.
pause
exit /b 1

:frontend_ok

REM 5. Install Playwright Chromium browser if missing
if exist "%LOCALAPPDATA%\ms-playwright\chromium-*" goto :playwright_ok
echo   [SETUP] Downloading Chromium browser for Playwright...
echo   This is a one-time download.
echo.
call npx playwright install chromium

:playwright_ok

REM 6. Initialize .env file if missing
if exist ".env" goto :env_ok
if exist ".env.example" (
    echo   [SETUP] Initializing .env configuration file...
    copy .env.example .env >nul
)

:env_ok

REM 7. Ensure required runtime folders exist
if not exist "data\source" mkdir "data\source"
if not exist "data\screenshots" mkdir "data\screenshots"
if not exist "config" mkdir "config"
if not exist "output" mkdir "output"

echo.
echo   ==================================================
echo     Starting Job Jet Services...
echo   ==================================================
echo.
echo   Web Dashboard:  http://localhost:5173
echo   API Server:     http://localhost:3001
echo.
echo   Opening Job Jet in your default web browser...
echo   Keep this terminal window open while using the app.
echo   Press Ctrl+C to stop the app at any time.
echo.

REM Automatically open the Web Dashboard in the user's default browser after 3 seconds
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:5173'"

REM Start both backend API server and frontend Vite server concurrently
call npx concurrently --names "API,UI" --prefix-colors "blue,green" --kill-others-on-fail "npx tsx src/server.ts" "cd ui && npm run dev"

echo.
echo   Job Jet has shut down.
pause
