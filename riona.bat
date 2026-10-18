@echo off
setlocal enabledelayedexpansion
title Riona AI Bot Manager
color 0A

set "PROJECT=C:\Users\Isaia\Documents\Coding\Riona_v3"
cd /d "%PROJECT%"

:: ── No args = show menu ──────────────────────────────────────────────
if "%~1"=="" goto :menu
if /i "%~1"=="start"   goto :start
if /i "%~1"=="stop"    goto :stop
if /i "%~1"=="restart" goto :restart
if /i "%~1"=="status"  goto :status
if /i "%~1"=="logs"    goto :logs
if /i "%~1"=="build"   goto :build
goto :menu

:: ── Interactive Menu ─────────────────────────────────────────────────
:menu
cls
echo.
echo   ========================================
echo        RIONA AI BOT MANAGER
echo   ========================================
echo.
echo    [1] Start Bot
echo    [2] Stop Bot
echo    [3] Restart Bot
echo    [4] Status
echo    [5] Live Logs
echo    [6] Build + Restart
echo    [7] Exit
echo.
set /p choice="   Choose [1-7]: "

if "%choice%"=="1" goto :start
if "%choice%"=="2" goto :stop
if "%choice%"=="3" goto :restart
if "%choice%"=="4" goto :status
if "%choice%"=="5" goto :logs
if "%choice%"=="6" goto :build
if "%choice%"=="7" exit /b 0
goto :menu

:: ── Start ────────────────────────────────────────────────────────────
:start
echo.
echo   [~] Checking if already running...
call npx pm2 list 2>nul | findstr /i "online" >nul
if not errorlevel 1 (
    echo   [!] Bot is already running. Use restart to refresh.
    echo.
    call npx pm2 list
    goto :done
)
echo   [~] Building TypeScript...
call npx tsc
if errorlevel 1 (
    echo   [X] Build failed! Fix errors first.
    goto :done
)
echo   [~] Starting all services...
call npx pm2 start ecosystem.config.js --update-env
echo.
echo   [OK] Bot started!
goto :done

:: ── Stop ─────────────────────────────────────────────────────────────
:stop
echo.
echo   [~] Stopping all services...
call npx pm2 stop all
echo.
echo   [OK] Bot stopped.
goto :done

:: ── Restart ──────────────────────────────────────────────────────────
:restart
echo.
echo   [~] Building TypeScript...
call npx tsc
if errorlevel 1 (
    echo   [X] Build failed! Keeping old version running.
    goto :done
)

call npx pm2 list 2>nul | findstr /i "online" >nul
if not errorlevel 1 (
    echo   [~] Restarting all services with new build...
    call npx pm2 restart all --update-env
) else (
    echo   [~] No services running. Starting fresh...
    call npx pm2 start ecosystem.config.js --update-env
)
echo.
echo   [OK] Bot restarted with latest code!
goto :done

:: ── Status ───────────────────────────────────────────────────────────
:status
echo.
call npx pm2 list
echo.
echo   --- Recent Activity (last 10 lines per service) ---
echo.
call npx pm2 logs --lines 5 --nostream 2>nul | findstr /v "DEP0040"
goto :done

:: ── Logs ─────────────────────────────────────────────────────────────
:logs
echo.
echo   [~] Streaming live logs (Ctrl+C to stop)...
echo.
call npx pm2 logs --lines 20
goto :done

:: ── Build + Restart ──────────────────────────────────────────────────
:build
echo.
echo   [~] Full build + restart...
echo   [~] Building TypeScript...
call npx tsc
if errorlevel 1 (
    echo   [X] Build failed!
    goto :done
)
echo   [~] Build OK. Restarting services...

call npx pm2 list 2>nul | findstr /i "online" >nul
if not errorlevel 1 (
    call npx pm2 restart all --update-env
) else (
    call npx pm2 start ecosystem.config.js --update-env
)
echo.
echo   [OK] Build + restart complete!
goto :done

:: ── Done ─────────────────────────────────────────────────────────────
:done
echo.
echo   Press any key to return to menu...
pause >nul
goto :menu
