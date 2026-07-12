@echo off
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0pair.ps1" %*
exit /b %ERRORLEVEL%
