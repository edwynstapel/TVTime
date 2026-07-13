@echo off
cd /d "%~dp0"
echo.
echo ========================================
echo   TV Time — Local Server
echo ========================================
echo.
echo Starting server on port 8080...
echo.
python -m http.server 8080 2>nul
if %errorlevel% neq 0 (
    echo Python is not installed yet.
    echo.
    echo To install (30 seconds, one click):
    echo   1. Open Microsoft Store from Start menu
    echo   2. Search "Python 3.13"
    echo   3. Click Install
    echo   4. Double-click this file again
    echo.
    echo After server starts, on your iPhone open Safari and go to:
    echo   http://YOUR-PC-IP:8080
    echo.
    echo Find your PC IP: open a terminal and type "ipconfig"
    echo Look for IPv4 Address under your Wi-Fi adapter
    echo.
    pause
) else (
    echo Server stopped.
    pause
)
