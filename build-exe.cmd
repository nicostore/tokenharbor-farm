@echo off
rem ============================================================
rem  tokenharbor-farm - build .exe (pakai pkg)
rem  Jalanin di Windows:  build-exe.cmd
rem  Hasil: dist\tokenharbor-farm.exe  (tanpa perlu install Node.js)
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan. Install dari https://nodejs.org dulu.
  pause
  exit /b 1
)

echo [1/3] Siapkan node_modules...
if not exist node_modules (
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [ERROR] npm install gagal. & pause & exit /b 1 )
)

echo [2/3] Install pkg (builder .exe)...
call npm install --no-save pkg --no-audit --no-fund
if errorlevel 1 ( echo [ERROR] install pkg gagal. & pause & exit /b 1 )

echo [3/3] Build exe...
if not exist dist mkdir dist
call npx pkg src\index.mjs --targets node18-win-x64 --output dist\tokenharbor-farm.exe
if errorlevel 1 ( echo [ERROR] build gagal. & pause & exit /b 1 )

echo.
echo ============================================================
echo  SUKSES!  dist\tokenharbor-farm.exe sudah jadi.
echo  Jalankan langsung tanpa perlu install Node.js lagi.
echo ============================================================
pause