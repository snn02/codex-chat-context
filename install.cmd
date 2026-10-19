@echo off
setlocal DisableDelayedExpansion
title Codex Chat Context - Install
echo Installing Codex Chat Context...
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "installExitCode=%ERRORLEVEL%"
echo.
if "%installExitCode%"=="0" (
    echo Installation succeeded. Fully restart Codex to use the panel.
) else (
    echo Installation failed with exit code %installExitCode%. See the details above.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %installExitCode%
