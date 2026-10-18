@echo off
cd /d "%~dp0"

echo Starting Instagram Bot at %date% %time%...

REM Set environment variables to reduce log verbosity
set NODE_OPTIONS=--max-old-space-size=4096 --trace-warnings
set DEBUG=puppeteer:*,-puppeteer:protocol:*

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Error installing dependencies
        exit /b 1
    )
)

REM Compile TypeScript
echo Compiling TypeScript...
call npx tsc
if errorlevel 1 (
    echo Error compiling TypeScript
    exit /b 1
)

REM Start the bot
echo Starting bot...
call npm run start
if errorlevel 1 (
    echo Error running bot
    exit /b 1
)

echo Bot finished at %date% %time%
