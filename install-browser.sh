#!/usr/bin/env bash
# ============================================================
#  tokenharbor-farm - install Chromium MANUAL untuk Linux/VPS
#  (paling stable — ganti `npx playwright install chromium`
#   yang suka hang di fase ekstraksi)
#  Pakai curl + python3 zipfile (bawaan). Idempoten: kalau
#  sudah terpasang, langsung skip.
# ============================================================
set -e
cd "$(dirname "$0")"

REV=1134
V=129.0.6668.29
URL="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${REV}/chromium-linux.zip"
MPDIR="$HOME/.cache/ms-playwright"
DEST="$MPDIR/chromium-${REV}"
C1="$DEST/chrome-linux/chrome"
C2="$MPDIR/chrome-linux/chrome"

echo "[1/4] Cek Chromium rev ${REV} sudah terpasang..."
if [ -x "$C1" ] || [ -x "$C2" ]; then
  echo "  Sudah ada — skip."
  exit 0
fi

echo "[2/4] Cek curl + python3..."
command -v curl >/dev/null || { echo "[ERROR] curl tidak ada. apt install curl"; exit 1; }
command -v python3 >/dev/null || { echo "[ERROR] python3 tidak ada. apt install python3"; exit 1; }

echo "[3/4] Download Chromium ${V} (~140MB)..."
mkdir -p "$MPDIR"
TMPZIP=$(mktemp "$MPDIR/chromium-${REV}-manual.XXXXXX.zip" 2>/dev/null || echo "$MPDIR/chromium-${REV}-manual.zip")
curl -L --retry 3 --retry-delay 5 -o "$TMPZIP" "$URL"
test -s "$TMPZIP" || { echo "[ERROR] Download gagal."; exit 1; }

echo "[4/4] Ekstrak (python zipfile — unzip sering gak ada)..."
python3 - "$TMPZIP" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
z.extractall(sys.argv[1].rsplit("/chromium-", 1)[0])
print(f"  extract {len(z.namelist())} files")
PY
rm -f "$TMPZIP"

# Normalisasi struktur: beberapa versi zip punya chrome-linux/chrome-linux/
if [ -f "$MPDIR/chrome-linux/chrome-linux/chrome" ] && [ ! -f "$MPDIR/chrome-linux/chrome" ]; then
  (cd "$MPDIR/chrome-linux" && [ -d chrome-linux ] && mv chrome-linux/* . && rmdir chrome-linux 2>/dev/null || true)
fi

chmod +x "$MPDIR/chrome-linux/chrome" \
  "$MPDIR/chrome-linux/chrome-wrapper" \
  "$MPDIR/chrome-linux/chrome_crashpad_handler" 2>/dev/null || true

# Symlink agar Playwright menemukan chromium-<rev>/chrome-linux/chrome
mkdir -p "$DEST"
ln -sfn ../chrome-linux "$DEST/chrome-linux"
chmod +x "$DEST/chrome-linux/chrome" 2>/dev/null || true
chmod +x "$DEST/chrome-linux/headless_shell" 2>/dev/null || true

# Deps sistem yang sering kurang di VPS baru
if command -v apt-get >/dev/null 2>&1; then
  echo "  Cek library sistem..."
  apt-get install -yqq libgbm1 libasound2 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libpango-1.0-0 libcairo2 libxshmfence1 libx11-xcb1 libxcb-dri3-0 >/dev/null 2>&1 || true
fi

if [ -x "$C1" ] || [ -x "$C2" ]; then
  echo "============================================================"
  echo "  SUKSES! Chromium terpasang di:"
  echo "  $([ -x "$C1" ] && echo "$C1" || echo "$C2")"
  echo "  Verifikasi: node -e \"require('playwright').chromium.launch()\""
  echo "  Jalanin farm: ./farm.sh"
  echo "============================================================"
else
  echo "  Ekstraksi selesai tapi chrome tidak ketemu."
  echo "  Isi folder:"
  ls "$MPDIR/chrome-linux" 2>/dev/null || ls "$MPDIR/chromium-${REV}" 2>/dev/null || echo "  (kosong — cek $MPDIR)"
  exit 1
fi