@echo off
setlocal
cd /d "%~dp0"
echo Starting Reliable Conversation Runtime live demo...
echo.
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Open the URL printed below, for example http://localhost:5173
echo If port 5173 is busy, the server will print the next available port.
echo.
call npm run live
pause
