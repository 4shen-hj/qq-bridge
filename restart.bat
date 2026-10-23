@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-bridge.ps1" -Root "%~dp0."
exit /b %errorlevel%
