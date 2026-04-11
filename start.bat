@echo off
echo.
echo   Auto Claude - Installing...
echo.
cd /d "%~dp0"
call npm install --no-fund --no-audit 2>nul
if errorlevel 1 (
    echo   Error: npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
)
echo.
echo   Starting Auto Claude...
echo.
call npm start
