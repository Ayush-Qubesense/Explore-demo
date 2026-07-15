@echo off
REM ===========================================================================
REM  OpsFlo snapshot demo launcher.
REM
REM  Double-click this instead of index.html.
REM
REM  Why: the AI command palette loads a local ML model (WebAssembly + ES
REM  modules), and browsers block both under file://. Serving from localhost
REM  fixes that and also gives voice search the secure context it requires.
REM  Opening index.html directly still works -- the palette just quietly falls
REM  back to keyword search instead of semantic search.
REM ===========================================================================
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Python was not found on PATH, so the local server cannot start.
  echo   You can still open index.html directly, but the palette will run in
  echo   keyword mode instead of semantic mode.
  echo.
  pause
  exit /b 1
)

echo.
echo   OpsFlo demo  ->  http://localhost:8000/index.html
echo   Close this window to stop the server.
echo.

start "" http://localhost:8000/index.html
python -m http.server 8000
