@echo off
title Hariom Invoice Watcher
cd /d "%~dp0"
echo Starting Hariom Invoice Watcher...
echo Watch folder: %WATCH_FOLDER%
echo.
node watcher.js
if errorlevel 1 (
    echo.
    echo Error: Watcher exited. Press any key to close.
    pause >nul
)
