@echo off
setlocal
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mobile-menu.ps1"
if errorlevel 1 pause
