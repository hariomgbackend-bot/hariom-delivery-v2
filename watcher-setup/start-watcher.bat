@echo off
title Hariom Invoice Watcher
cd /d "%~dp0"
node watcher.js
if errorlevel 1 (
    echo Error starting watcher. Press any key to close.
    pause >nul
)
