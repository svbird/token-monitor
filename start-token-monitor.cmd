@echo off
setlocal

rem Double-click to open Token Monitor. Configure Verdent in Settings.
rem Keep the same local profile as npm run verdent:dev.
set "TOKEN_MONITOR_LOGIN_ARG="
if "%~1"=="" goto check_runtime
if /i "%~1"=="--login" (
  set "TOKEN_MONITOR_LOGIN_ARG=--login"
  goto check_runtime
)
if /i "%~1"=="--check" goto check_runtime
echo Usage: start-token-monitor.cmd [--login ^| --check]
exit /b 2

:check_runtime
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 22.15 or newer, then try again.
  goto failed
)
node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || major === 22 && minor >= 15 ? 0 : 1);"
if errorlevel 1 (
  echo Node.js 22.15 or newer is required.
  goto failed
)
if not exist "%~dp0scripts\dev-verdent.js" (
  echo Cannot find scripts\dev-verdent.js next to this launcher.
  goto failed
)
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron is not ready. In this workspace, run:
  echo   npm ci
  echo   npm run verdent:dev
  echo Then use this launcher again.
  goto failed
)
if /i "%~1"=="--check" (
  echo Ready: Node.js, Electron and the Verdent entry point are available.
  exit /b 0
)

rem A parent tool can set this variable; the desktop app needs normal Electron mode.
set "ELECTRON_RUN_AS_NODE="
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0scripts\dev-verdent.js" %TOKEN_MONITOR_LOGIN_ARG%
if errorlevel 1 (
  echo Token Monitor could not be started.
  goto failed
)
exit /b 0

:failed
if /i "%~1"=="--check" exit /b 1
pause
exit /b 1
