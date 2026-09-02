@echo off
REM ============================================================
REM  ComfyUI Helper - Debug launcher
REM  Usage: run-debug.bat           (GPU off + remote debug 9222)
REM         run-debug.bat nogpu     (force software rendering)
REM         run-debug.bat gpudbg    (keep GPU on)
REM  Log:   <exe dir>\logs\app.log
REM  ASCII-only file - do NOT convert to UTF-8 with CJK text.
REM ============================================================
setlocal
set "EXE=%~dp0release\comfyui-helper.exe"
if not exist "%EXE%" (
    set "EXE=%~dp0src-tauri\target\release\comfyui-helper.exe"
)
if not exist "%EXE%" (
    echo [ERROR] comfyui-helper.exe not found.
    echo         Run build-release.bat first.
    pause
    exit /b 1
)

for %%D in ("%EXE%") do set "EXEDIR=%%~dpD"
cd /d "%EXEDIR%"

REM Remote debugging: open http://localhost:9222 in Edge/Chrome
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222"

if /i "%1"=="gpudbg" (
    echo [MODE] GPU enabled + remote debug
) else (
    set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=%WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS% --disable-gpu --disable-gpu-compositing"
    echo [MODE] GPU disabled + remote debug
)

echo.
echo [EXE ] %EXE%
echo [LOG ] %EXEDIR%logs\app.log
echo [CDP ] http://localhost:9222
echo.
"%EXE%"
echo.
echo [EXIT] Process exited with code %errorlevel%
echo [NEXT] Send %EXEDIR%logs\app.log to AI for diagnosis.
echo.
pause
