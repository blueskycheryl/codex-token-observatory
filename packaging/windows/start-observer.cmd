@echo off
setlocal
set "ROOT=%~dp0"
set "PORT=4399"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist "%ROOT%scripts\observer.mjs" (
  echo Cannot find scripts\observer.mjs.
  pause
  exit /b 1
)

start "Codex Token Observatory" /b node "%ROOT%scripts\observer.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%"
endlocal
