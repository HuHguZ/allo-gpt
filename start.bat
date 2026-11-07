@echo off
setlocal
chcp 65001 >nul
title GPT-Live Phone
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\tsx" (
  echo Installing dependencies...
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node -e "try{process.loadEnvFile('.env')}catch{};process.exit(process.env.PHONE_MODE==='live'?0:1)"
if not errorlevel 1 (
  call npm run setup:asterisk
  if errorlevel 1 (
    pause
    exit /b 1
  )
  echo Starting the phone gateway. Docker Desktop must be running.
  docker compose up -d asterisk
  if errorlevel 1 (
    echo Start Docker Desktop and try again.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
