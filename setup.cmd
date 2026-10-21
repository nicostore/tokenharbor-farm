@echo off
rem ============================================================
rem  tokenharbor-farm - setup sekali pakai (Windows)
rem  1) Cek Node.js   2) npm install   3) Browser:
rem     - pakai Microsoft Edge kalau ada (TANPA download 140MB)
rem     - kalau nggak ada, download Chromium MANUAL via cdn.playwright.dev
rem       (azureedge/playwright.download.prss.microsoft.com DNS sering gagal)
rem ============================================================
cd /d "%~dp0"
setlocal EnableExtensions

echo [1/3] Cek Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan. Install dari https://nodejs.org
  pause
  exit /b 1
)
node --version

echo [2/3] Install dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [ERROR] npm install gagal.
  pause
  exit /b 1
)

echo [3/3] Cek browser...
set "EDGE1=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE1%" goto :edge
if exist "%EDGE2%" goto :edge
goto :chromium

:edge
echo  Microsoft Edge ditemukan - tidak perlu Chromium. Selesai!
goto :done

:chromium
echo  Edge TIDAK ditemukan - install Chromium manual (stable, gak stuck)...
set "REV=1134"
set "V=129.0.6668.29"
set "URL=https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/%REV%/chromium-win64.zip"
set "MPDIR=%LOCALAPPDATA%\ms-playwright"
set "ZIP=%MPDIR%\chromium-%REV%-manual.zip"
set "DEST=%MPDIR%\chromium-%REV%"
set "C1=%DEST%\chrome-win64\chrome.exe"

if exist "%C1%" (
  echo  Chromium sudah terpasang. Selesai!
  goto :done
)

echo  Download Chromium %V% ~140MB...
where curl >nul 2>nul
if errorlevel 1 (
  echo [ERROR] curl tidak ditemukan. Windows 10/11 harusnya punya.
  pause
  exit /b 1
)
if not exist "%MPDIR%" mkdir "%MPDIR%"
curl -L --retry 3 --retry-delay 5 -o "%ZIP%" "%URL%"
if errorlevel 1 (
  echo [ERROR] Download gagal. Cek internet, lalu jalankan ulang setup.cmd
  pause
  exit /b 1
)

echo  Ekstrak (PowerShell)...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%DEST%' -Force"
if errorlevel 1 (
  echo [ERROR] Ekstraksi gagal.
  pause
  exit /b 1
)
del "%ZIP%"

if not exist "%C1%" (
  :: beberapa zip menaruh chrome-win, bukan chrome-win64
  if exist "%DEST%\chrome-win" ren "%DEST%\chrome-win" chrome-win64
)
if not exist "%C1%" (
  echo [ERROR] chrome.exe tidak ketemu setelah ekstrak:
  dir /b "%DEST%"
  pause
  exit /b 1
)
echo  Chromium terpasang. Selesai!

:done
echo.
echo ============================================================
echo  Setup selesai! Jalanin bot:  double-click farm.cmd
echo ============================================================
pause