@echo off
rem ============================================================
rem  tokenharbor-farm - setup sekali pakai (Windows RDP)
rem  jalankan SEKALI setelah clone repo.
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

echo [3/3] Install Chromium untuk Playwright...
call npx playwright install chromium

echo.
echo ============================================================
echo  Setup selesai! Jalanin bot:  double-click farm.cmd
echo ============================================================
pause