@echo off
rem ============================================================
rem  tokenharbor-farm - install Chromium MANUAL (paling stable)
rem  Menggantikan `npx playwright install chromium` yang sering
rem  stuck di ekstraksi. Pakai curl.exe + PowerShell bawaan
rem  Windows (tidak butuh browser, tidak butuh download manual).
rem
rem  Hanya perlu dijalankan KALAU Microsoft Edge tidak ada.
rem  (Bot biasanya pakai Edge - lihat farm.cmd)
rem ============================================================
cd /d "%~dp0"

set "REV=1134"
set "V=129.0.6668.29"
set "URL=https://playwright.azureedge.net/builds/chromium/%REV%/chromium-win64.zip"
set "MPDIR=%LOCALAPPDATA%\ms-playwright"
set "ZIP=%MPDIR%\chromium-%REV%-manual.zip"
set "DEST=%MPDIR%\chromium-%REV%"

echo [1/4] Cek curl.exe...
where curl >nul 2>nul
if errorlevel 1 (
  echo [ERROR] curl tidak ditemukan. Windows 10/11 harusnya punya.
  pause
  exit /b 1
)

echo [2/4] Buat folder browser...
if not exist "%MPDIR%" mkdir "%MPDIR%"

echo [3/4] Download Chromium %V% (%REV%) - 140MB, ini yang lama...
curl -L --retry 3 --retry-delay 5 -o "%ZIP%" "%URL%"
if errorlevel 1 (
  echo [ERROR] Download gagal. Cek internet, lalu jalankan ulang.
  pause
  exit /b 1
)

echo [4/4] Ekstrak (PowerShell - reliable)...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%DEST%' -Force"
if errorlevel 1 (
  echo [ERROR] Ekstraksi gagal.
  pause
  exit /b 1
)
del "%ZIP%"

echo.
echo ============================================================
set "CHROME=%DEST%\chrome-win64\chrome.exe"
if exist "%CHROME%" (
  echo  SUKSES! Chromium terpasang di:
  echo    %CHROME%
) else (
  if exist "%DEST%\chrome-win\chrome.exe" (
    echo  SUKSES! (versi chrome-win) - rename dulu biar dikenali...
    ren "%DEST%\chrome-win" chrome-win64
    echo  selesai.
  ) else (
    echo  Ekstraksi selesai tapi path chrome.exe tidak ditemukan.
    echo  Isi folder:
    dir /b "%DEST%"
  )
)
echo  Sekarang jalanin farm.cmd
echo ============================================================
pause