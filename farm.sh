#!/usr/bin/env bash
# tokenharbor-farm — launcher Linux/VPS (Ubuntu, Debian, dsb).
# Windows pakai farm.cmd. Pakai: ./farm.sh  [atau]  bash farm.sh
set -e
cd "$(dirname "$0")"

# node minimal v20+ (butuh node:sqlite v22+ untuk import-9router; farm butuh v18+)
if ! command -v node >/dev/null 2>&1; then
  echo "node tidak ada — install dulu: apt install nodejs npm  (atau pakai nvm)"
  exit 1
fi

# playwright browser (chromium) belum ada?
if [ ! -d "$HOME/.cache/ms-playwright" ] || [ -z "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ]; then
  echo "Playwright browser belum ke-install — install manual (stable, gak hang)..."
  bash install-browser.sh || {
    echo "Install browser gagal. Coba manual: bash install-browser.sh"
    exit 1
  }
fi

exec node src/tui.mjs "$@"