@echo off
setlocal
cd /d "%~dp0"
echo Starting Reliable Conversation Runtime live demo...
echo.
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
start "" "http://localhost:5173"
call npm run live
pause
