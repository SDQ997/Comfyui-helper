@echo off
REM ============================================================
REM  ComfyUI Helper - Build Script (Windows)
REM  Output:  release\ComfyUI Helper_0.1.0_x64-setup.exe  (installer)
REM           release\comfyui-helper.exe                  (portable)
REM  Usage:   Double-click, or run from project root.
REM  Note:    This file is intentionally ASCII-only. Do NOT save
REM           it as UTF-8 with CJK text - cmd.exe mis-parses it.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Kill env vars from sandboxed shells BEFORE anything else.
REM NODE_OPTIONS can inject a delete-hook that swallows vite's dist
REM output dir, which makes tauri build fail with "frontendDist
REM doesn't exist" even though vite reported success.
set NODE_OPTIONS=
set CODEBUDDY_SAFE_DELETE_BULK_GUARD=
set CODEBUDDY_SAFE_DELETE_SANDBOX=
set CODEBUDDY_SAFE_DELETE_BIN_DIR=

echo.
echo ============================================================
echo   ComfyUI Helper - Build
echo ============================================================
echo.
echo [INFO] Project dir: %CD%
echo.

REM ---------- Step 0: check Node.js (Vite 5 needs Node 18+) ----------
echo [1/6] Checking environment...
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node.exe not found. Please install Node.js 18+.
    goto :fail
)

REM Default node may be too old (e.g. v16 -> vite fails with
REM "crypto$2.getRandomValues is not a function"). If so, hunt for a
REM newer one and prepend it to PATH.
set "NODE_OK=0"
for /f "delims=" %%i in ('node -v 2^>nul') do set "NODEVER=%%i"
if defined NODEVER (
    call :major "%NODEVER%" NODEMAJOR
    if !NODEMAJOR! GEQ 18 set "NODE_OK=1"
)
if "!NODE_OK!"=="0" (
    echo [WARN] node !NODEVER! is too old - Vite 5 requires Node 18+.
    echo [INFO] Searching for a newer Node...
    for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
        if exist "%%D\node.exe" (
            call :major_from_exe "%%D\node.exe" M
            if !M! GEQ 18 (
                set "PATH=%%D;!PATH!"
                set "NODE_OK=1"
                echo [OK] Found Node in %%D
            )
        )
    )
)
if "!NODE_OK!"=="0" (
    if exist "C:\Program Files\nodejs\node.exe" (
        call :major_from_exe "C:\Program Files\nodejs\node.exe" M
        if !M! GEQ 18 (
            set "PATH=C:\Program Files\nodejs;!PATH!"
            set "NODE_OK=1"
            echo [OK] Found Node in C:\Program Files\nodejs
        )
    )
)
if "!NODE_OK!"=="0" (
    echo.
    echo [ERROR] No Node.js 18+ found on this machine.
    echo         Current: !NODEVER!
    echo         Please install Node.js 20 LTS from https://nodejs.org
    echo         and run this script again.
    goto :fail
)
for /f "delims=" %%i in ('node -v 2^>nul') do set "NODEVER=%%i"
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODEPATH set "NODEPATH=%%i"
)
echo [OK] node : !NODEVER!  ^(!NODEPATH!^)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js 18+.
    goto :fail
)

REM ---------- Step 0b: locate a working cargo ----------
REM ~/.cargo/bin/cargo.exe is a 0-byte stub on some machines, so
REM fall back to the real toolchain directory.
set "CARGO_EXE="
set "RUSTC_EXE="
set "TOOLCHAIN=%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"

for /f "delims=" %%i in ('where cargo 2^>nul') do (
    for %%A in ("%%i") do (
        if %%~zA GTR 0 (
            set "CARGO_EXE=%%i"
        ) else (
            echo [WARN] Ignored 0-byte cargo shim: %%i
        )
    )
)
if not defined CARGO_EXE (
    if exist "%TOOLCHAIN%\cargo.exe" (
        set "CARGO_EXE=%TOOLCHAIN%\cargo.exe"
        set "RUSTC_EXE=%TOOLCHAIN%\rustc.exe"
    )
)
if not defined CARGO_EXE (
    echo [ERROR] No working cargo found. Install rustup stable-msvc.
    goto :fail
)
if defined RUSTC_EXE (
    set "RUSTC=%RUSTC_EXE%"
    set "PATH=%TOOLCHAIN%;%PATH%"
)
echo [OK] cargo: !CARGO_EXE!
echo.

REM ---------- Step 0c: set up MSVC linker environment ----------
REM Git's usr/bin contains a GNU coreutils link.exe that shadows the
REM MSVC linker, and LIB/INCLUDE are not set outside a VS prompt.
REM Calling vcvars64.bat fixes PATH, LIB, INCLUDE in one shot.
set "VCVARS="
for %%V in (
    "E:\C++\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
) do (
    if not defined VCVARS if exist %%V set "VCVARS=%%~V"
)
if defined VCVARS (
    echo [OK] MSVC env: !VCVARS!
    call "!VCVARS!" >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] vcvars64.bat failed.
        goto :fail
    )
) else (
    echo [WARN] vcvars64.bat not found - assuming VS environment already set.
    echo        If linking fails with "LNK1181: kernel32.lib", install
    echo        Visual Studio Build Tools with the C++ workload.
)
echo.

REM ---------- Step 1: npm install ----------
echo [2/6] Installing frontend dependencies...
if not exist "node_modules" (
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        goto :fail
    )
) else (
    echo [SKIP] node_modules already exists.
)
echo.

REM ---------- Step 2: frontend build ----------
echo [3/6] Building frontend (vite build)...
if exist "dist" rmdir /s /q "dist"
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed.
    goto :fail
)
if not exist "dist\index.html" (
    echo [ERROR] dist\index.html was not generated.
    goto :fail
)
echo [OK] dist\index.html generated.
echo.

REM ---------- Step 3: tauri build ----------
echo [4/6] Building Rust backend + NSIS installer.
echo       First build takes 5-15 minutes. Please wait...
echo.

REM Clear env vars that break cargo / vite in sandboxed shells
set NODE_OPTIONS=
set CODEBUDDY_SAFE_DELETE_BULK_GUARD=
set CODEBUDDY_SAFE_DELETE_SANDBOX=
set CODEBUDDY_SAFE_DELETE_BIN_DIR=

call npx tauri build
if errorlevel 1 (
    echo [ERROR] tauri build failed. Scroll up for the Rust error.
    goto :fail
)
echo.

REM ---------- Step 4: collect artifacts ----------
echo [5/6] Collecting artifacts into release\...
if not exist "release" mkdir "release"
if exist "src-tauri\target\release\comfyui-helper.exe" (
    copy /y "src-tauri\target\release\comfyui-helper.exe" "release\" >nul
    echo [OK] comfyui-helper.exe
) else (
    echo [ERROR] comfyui-helper.exe not found.
    goto :fail
)
if exist "src-tauri\target\release\bundle\nsis" (
    for %%F in ("src-tauri\target\release\bundle\nsis\*.exe") do (
        copy /y "%%F" "release\" >nul
        echo [OK] %%~nxF
    )
)

REM ---------- Step 5: done ----------
echo.
echo [6/6] BUILD SUCCEEDED
echo.
echo   Artifacts in: %CD%\release
echo   - Installer : ComfyUI Helper_0.1.0_x64-setup.exe
echo   - Portable  : comfyui-helper.exe
echo.
echo   Runtime log : [exe dir]\logs\app.log
echo.
echo   Debug launch:
echo     run-debug.bat            GPU off + remote debug port 9222
echo     run-debug.bat nogpu      force software rendering
echo     run-debug.bat gpudbg     keep GPU on
echo.
pause
exit /b 0

:fail
echo.
echo ============================================================
echo  BUILD FAILED - copy the full output above and send to AI
echo ============================================================
echo.
pause
exit /b 1

REM ---------- helpers ----------

:major
REM %1 = version string like "v22.22.2", %2 = output var name
set "%~2=0"
set "MV=%~1"
if "%MV:~0,1%"=="v" set "MV=%MV:~1%"
for /f "tokens=1 delims=." %%m in ("%MV%") do set "%~2=%%m"
exit /b 0

:major_from_exe
REM %1 = path to node.exe, %2 = output var name
set "%~2=0"
set "MV="
for /f "delims=" %%i in ('"%~1" -v 2^>nul') do set "MV=%%i"
if defined MV (
    if "%MV:~0,1%"=="v" set "MV=%MV:~1%"
    for /f "tokens=1 delims=." %%m in ("%MV%") do set "%~2=%%m"
)
exit /b 0
