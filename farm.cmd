@echo off
rem ============================================================
rem  tokenharbor-farm - Windows launcher (untuk RDP)
rem  Jalanin TUI interaktif. Butuh Node.js >= 18 sudah install.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan di PATH.
  echo         Install dari https://nodejs.org lalu buka cmd baru.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [SETUP] node_modules belum ada - install dulu...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install gagal. Cek koneksi internet lalu coba lagi.
    pause
    exit /b 1
  )
  echo [SETUP] Selesai. (bot pakai Microsoft Edge - TANPA download Chromium)
)

echo.
echo ============================================================
echo   TOKENHARBOR-FARM  -  mulai TUI
echo   (ctrl-c untuk keluar)
echo ============================================================
echo.
node src\tui.mjs
pause