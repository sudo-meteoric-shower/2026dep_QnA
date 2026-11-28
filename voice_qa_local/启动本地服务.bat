@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
    py -3 serve.py --open-gpu
) else (
    python serve.py --open-gpu
)
if errorlevel 1 (
    pause
    exit /b 1
)
