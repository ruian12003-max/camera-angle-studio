@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
start "" "http://127.0.0.1:43127"
node server.js
pause
