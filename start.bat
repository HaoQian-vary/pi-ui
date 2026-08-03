@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js ^>= 20 first.
  pause
  exit /b 1
)

rem --- Check pi ---
where pi >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pi not found. pi is required as the AI engine.
  echo.
  echo   Windows / macOS / Linux ^(npm^):  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  echo   macOS / Linux ^(installer^):      curl -fsSL https://pi.dev/install.sh ^| sh
  echo.
  echo   After install, run this script again.
  pause
  exit /b 1
)

rem --- Clean up old server on port 3838 ---
netstat -ano | findstr ":3838" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [CLEANUP] Port 3838 is in use. Closing old pi-web server...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3838" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>nul
  )
  timeout /t 1 /nobreak >nul
)

if not exist node_modules (
  echo [SETUP] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [BUILD] Building frontend...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

start "" http://127.0.0.1:3838
node server.mjs
pause
