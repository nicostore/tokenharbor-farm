@echo off
rem ============================================================
rem  tokenharbor-farm - install Chromium MANUAL (paling stable)
rem  Ganti `npx playwright install chromium` yang suka stuck.
rem  Pakai curl.exe + PowerShell bawaan Windows.
rem  Kalau Chromium sudah pernah terpasang, langsung skip.
rem
rem  URL pakai cdn.playwright.dev (dbazure) — SAMA dengan versi
rem  Linux. playwright.azureedge.net redirect ke
rem  playwright.download.prss.microsoft.com yang DNS-nya sering
rem  gagal di jaringan rumahan/VPS Indonesia.
rem ============================================================
cd /d "%~dp0"
setlocal EnableExtensions

set "REV=1134"
set "V=129.0.6668.29"
set "URL=https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/%REV%/chromium-win64.zip"
set "MPDIR=%LOCALAPPDATA%\ms-playwright"
set "ZIP=%MPDIR%\chromium-%REV%-manual.zip"
set "DEST=%MPDIR%\chromium-%REV%"
set "C1=%DEST%\chrome-win64\chrome.exe"
set "C2=%DEST%\chrome-win\chrome.exe"

echo [1/4] Cek Chromium sudah terpasang...
if exist "%C1%" goto :done
if exist "%C2%" goto :fixdir

echo [2/4] Cek curl.exe...
where curl >nul 2>nul
if errorlevel 1 (
  echo [ERROR] curl tidak ditemukan. Windows 10/11 harusnya punya.
  pause
  exit /b 1
)

echo [3/4] Download Chromium %V% - 140MB...
if not exist "%MPDIR%" mkdir "%MPDIR%"
curl -L --retry 3 --retry-delay 5 -o "%ZIP%" "%URL%"
if errorlevel 1 (
  echo [ERROR] Download gagal. Cek internet, lalu jalankan ulang.
  pause
  exit /b 1
)

echo [4/4] Ekstrak pakai PowerShell...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%DEST%' -Force"
if errorlevel 1 (
  echo [ERROR] Ekstraksi gagal.
  pause
  exit /b 1
)
del "%ZIP%"

if exist "%C1%" goto :done
if exist "%C2%" goto :fixdir

echo ============================================================
echo  Ekstraksi selesai tapi chrome.exe tidak ketemu.
echo  Isi folder:
dir /b "%DEST%"
echo ============================================================
pause
exit /b 1

:fixdir
echo  Deteksi folder chrome-win, rename jadi chrome-win64...
ren "%DEST%\chrome-win" chrome-win64
echo  selesai.

:done
echo ============================================================
echo  SUKSES! Chromium terpasang di:
echo  %C1%
echo  Sekarang jalanin farm.cmd
echo ============================================================
pause