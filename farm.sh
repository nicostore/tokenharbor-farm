#!/usr/bin/env bash
# tokenharbor-farm — setup + launcher Linux/VPS (Ubuntu/Debian).
# Sekali jalan: cek node → npm install → install Chromium manual kalau belum
# ada → jalankan farm. Windows pakai setup.cmd + farm.cmd.
set -e
cd "$(dirname "$0")"

# ---------- 1. Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node tidak ada — install dulu: apt install nodejs npm  (atau pakai nvm)"
  exit 1
fi
echo "[1/3] Node: $(node --version)"

# ---------- 2. Dependencies ----------
if [ ! -d node_modules ]; then
  echo "[2/3] npm install..."
  npm install --no-audit --no-fund
else
  echo "[2/3] node_modules sudah ada — skip"
fi

# ---------- 3. Chromium (manual, stable — azureedge DNS sering gagal) ----------
REV=1134
MPDIR="$HOME/.cache/ms-playwright"
C1="$MPDIR/chromium-${REV}/chrome-linux/chrome"
C2="$MPDIR/chrome-linux/chrome"
if [ -x "$C1" ] || [ -x "$C2" ]; then
  echo "[3/3] Chromium rev ${REV} sudah ada — skip"
else
  echo "[3/3] Install Chromium rev ${REV} (~140MB, manual)..."
  URL="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${REV}/chromium-linux.zip"
  command -v curl >/dev/null || { echo "[ERROR] curl tidak ada: apt install curl"; exit 1; }
  command -v python3 >/dev/null || { echo "[ERROR] python3 tidak ada: apt install python3"; exit 1; }
  mkdir -p "$MPDIR"
  TMPZIP="$MPDIR/chromium-${REV}-manual.zip"
  echo "  download..."
  curl -L --retry 3 --retry-delay 5 -o "$TMPZIP" "$URL"
  test -s "$TMPZIP" || { echo "[ERROR] Download gagal — coba lagi: bash farm.sh"; exit 1; }
  echo "  extract (python zipfile)..."
  python3 -c "
import zipfile
z = zipfile.ZipFile('$TMPZIP'); z.extractall('$MPDIR'); print('  ', len(z.namelist()), 'files')"
  rm -f "$TMPZIP"
  # normalisasi struktur chrome-linux/chrome-linux (beberapa versi zip)
  if [ -f "$MPDIR/chrome-linux/chrome-linux/chrome" ] && [ ! -f "$MPDIR/chrome-linux/chrome" ]; then
    (cd "$MPDIR/chrome-linux" && [ -d chrome-linux ] && mv chrome-linux/* . && rmdir chrome-linux 2>/dev/null || true)
  fi
  chmod +x "$MPDIR/chrome-linux/chrome" "$MPDIR/chrome-linux/chrome-wrapper" "$MPDIR/chrome-linux/chrome_crashpad_handler" 2>/dev/null || true
  mkdir -p "$MPDIR/chromium-${REV}"
  ln -sfn ../chrome-linux "$MPDIR/chromium-${REV}/chrome-linux" 2>/dev/null || true
  # deps sistem yang sering kurang di VPS baru
  if command -v apt-get >/dev/null 2>&1; then
    echo "  cek library sistem..."
    apt-get install -yqq libgbm1 libasound2 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libpango-1.0-0 libcairo2 libxshmfence1 libx11-xcb1 libxcb-dri3-0 >/dev/null 2>&1 || true
  fi
  [ -x "$C1" ] || [ -x "$C2" ] || { echo "[ERROR] chrome tidak ketemu setelah ekstrak: $(ls "$MPDIR" 2>/dev/null)"; exit 1; }
  echo "[3/3] Chromium terpasang ✅"
fi

# ---------- 4. Jalankan farm ----------
echo ""
exec node src/tui.mjs "$@"