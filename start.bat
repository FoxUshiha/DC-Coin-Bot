@echo off
title Coin Bank
cd /d "%~dp0"
if not exist "node_modules" (
  echo [Coin Bank] Installing dependencies...
  call npm install --omit=dev
)
:start
echo [Coin Bank] Starting...
node --expose-gc --max-old-space-size=384 index.js
echo [Coin Bank] Stopped (code %errorlevel%). Restarting in 5 seconds... (Ctrl+C to quit)
timeout /t 5 /nobreak >nul
goto start
