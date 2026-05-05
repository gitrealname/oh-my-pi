@echo off
:: deploy.cmd -- copy omp binary + mreview sidecar to %LOCALAPPDATA%\omp\
:: Stop omp before running: the exe is locked while the process is running.
setlocal

set BINARIES_DIR=%~dp0packages\coding-agent\binaries
set TARGET_DIR=%LOCALAPPDATA%\omp

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

echo Deploying omp-aws-corp.exe ...
copy /Y "%BINARIES_DIR%\omp-aws-corp.exe" "%TARGET_DIR%\omp.exe"
if errorlevel 1 (
    echo ERROR: copy failed. Is omp.exe still running? Stop the process first.
    exit /b 1
)

echo Deploying mreview-editor.ui.html ...
copy /Y "%~dp0packages\coding-agent\src\tools\mreview\mreview-editor.ui.html" "%TARGET_DIR%\mreview-editor.ui.html"
if errorlevel 1 (
    echo ERROR: failed to copy mreview-editor.ui.html
    exit /b 1
)

echo Done. Deployed to %TARGET_DIR%
endlocal
