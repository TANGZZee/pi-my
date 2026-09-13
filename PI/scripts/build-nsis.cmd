@echo off
setlocal

rem Load the Visual Studio C++ build environment before Rust compiles native dependencies.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSROOT="

if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VSROOT=%%I"
)

if not defined VSROOT if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VSROOT=%ProgramFiles%\Microsoft Visual Studio\2022\Community"

if not defined VSROOT (
  echo Visual Studio C++ build tools were not found.
  exit /b 1
)

call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

call npm run tauri build -- --bundles nsis
exit /b %errorlevel%
