@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto NO_NODE

start "" "http://127.0.0.1:43127"
node server.js
if errorlevel 1 goto SERVER_ERROR
exit /b 0

:NO_NODE
echo [ERROR] Node.js 20 or newer was not found.
echo Please install Node.js from https://nodejs.org/
pause
exit /b 1

:SERVER_ERROR
echo [ERROR] The local server could not start.
echo Check whether port 43127 is already in use.
pause
exit /b 1
