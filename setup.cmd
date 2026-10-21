@echo off
rem ============================================================
rem  tokenharbor-farm - setup sekali pakai (Windows RDP)
rem  PAKAI Microsoft Edge bawaan (channel msedge) — TANPA
rem  download Chromium 140MB yang lama. Optional: kalau Edge
rem  tidak ada, baru download Chromium.
rem ============================================================
cd /d "%~dp0"

echo [1/3] Cek Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan. Install https://nodejs.org
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

echo [3/3] Cek Microsoft Edge (browser utama bot)...
set "EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE_PATH%" (
  echo  Edge ditemukan - tidak perlu download Chromium. Selesai!
) else (
  if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    echo  Edge ditemukan - tidak perlu download Chromium. Selesai!
  ) else (
    echo  Edge TIDAK ditemukan. Install Chromium manual (stable, gak stuck)...
    call install-browser.cmd
  )
)

echo.
echo ============================================================
echo  Setup selesai! Jalanin bot:  double-click farm.cmd
echo  (pakai Microsoft Edge - skip Chromium 140MB yang lama)
echo ============================================================
pause