# TokenHarbor Farm

Farm CLI untuk bikin akun + API key TokenHarbor (tokenharbor.ai) secara massal.
Full interactive UI, jalan di **Windows (RDP)** maupun Linux (**VPS/Ubuntu**).

## Run

```bash
# Linux/VPS — setup + browser + jalan (browser di-install manual, gak hang)
bash install-browser.sh      # sekali: Chromium manual (opsional — farm.sh auto-install)
./farm.sh                    # auto: install-browser.sh kalau browser belum ada

# Windows — setup + browser + jalan (Edge kalau ada, skip Chromium 140MB)
setup.cmd                    # sekali: npm install; kalau gak ada Edge → panggil install-browser.cmd
farm.cmd
```

## Auto-stock proxy (langsung jalan, nggak perlu list manual)

```bash
node src/stock.mjs            # fetch 4 sumber free list + check CONNECT ke target + isi pool
node src/stock.mjs 100        # sampai minimal 100 proxy alive
```
Di UI: menu `0. Auto-stock proxy`, atau START farm otomatis stock kalau pool < 5.

## Recheck + quota

```bash
node src/recheck.mjs          # login ulang semua akun accounts.jsonl: aktifkan free models
                              # kalau tombol muncul, cek quota (/api/me/free-tier), tulis keys-recheck.txt
node src/recheck.mjs 20 3     # 20 akun, 3 paralel
```

## Import ke 9router (otomatis, VPS)

```bash
node src/import-9router.mjs   # baca keys.txt + insert connection per key ke node TokenHarbor
```

## Fitur

- **Full UI CLI** — menu interaktif + dashboard live (status realtime, event ringkas, bukan log spam)
- **Mode rotate-IP** — target N key lalu otomatis berhenti, atau sampai di-stop
- **Proxy on/off** — bebas pakai proxy pool atau langsung IP bawaan
- **Worker settings** — jumlah worker, retry, inbox provider, hybrid on/off
- **Output file settings** — keys file, accounts file, logs directory — semua bisa di-set & persist di `config.json`
- **Hybrid flow** — signup lewat proxy, verify email + mint API key lewat **IP bawaan** (kombinasi yang menghasilkan key: anti-abuse signup + Vercel checkpoint lolos)
- **Cooldown bertingkat** — proxy soft (90s), rate (30m/60m), banned permanen (3x) — pool awet
- **Log event** di layar (ringkas) + **full logs** ke file, auto-clear tiap run
- **Inbox multi-provider** — tempmail.lol, mail.tm, guerrillamail, temp-email.dev (auto milih random per akun)

## Setup (Windows RDP)

1. Install [Node.js 18+](https://nodejs.org)
2. Clone repo
3. Jalankan `setup.cmd` (install deps + Chromium, sekali doang)
4. Taruh proxy list di `pools/proxies.txt` — format per baris:
   ```
   host:port
   host:port:user:pass
   ```
5. Double-click `farm.cmd` untuk mulai

## Pakai

Menu interaktif:
```
 1. Proxy:           ON (328 proxy)
 2. File proxy:      pools/proxies.txt
 3. Worker:          3
 4. Inbox provider:  auto
 5. Hybrid:          ON
 6. Output keys:     keys.txt
 7. Output accounts: accounts.jsonl
 8. Target:          0 (∞ sampai stop)
 9. ▶ START farm
 S. Stop farm
```
- Pilih angka lalu Enter buat ubah setting (toggle)
- `9` mulai farm — layar pindah ke dashboard live
- `s` stop, `q` keluar, ctrl-c force

## CLI headless (Linux / server)

```bash
# farm sampai 50 key
node src/core/farm.mjs --target 50

# farm tanpa batas
node src/core/farm.mjs
```

## Struktur

```
src/
├── config.mjs        # settings + persist config.json
├── events.mjs        # event bus (TUI subscribe)
├── tui.mjs           # UI interaktif + dashboard live
├── core/
│   ├── farm.mjs      # orchestrator (spawn worker, monitor target)
│   ├── worker.mjs    # per-worker loop (proxy pick, provision, event emit)
│   └── provision.mjs # hybrid flow: signup proxy → verify+mint IP bawaan
├── inbox/            # reader tempmail.lol / mail.tm / guerrillamail / temp-email.dev
├── tokenharbor/      # client signup/verify/api-key (Playwright)
└── utils/            # logger (file), random
```

## Output

- `keys.txt` — satu `thk_live_...` per baris (append)
- `accounts.jsonl` — email + password + key + proxy + hybrid flag
- `logs/farm.log` + `logs/worker-N.log` — full logs (auto-clear tiap run, max 5MB)

## Catatan

- Proxy yang rate-limit di-cooldown 30m; setelah 3x di-ban permanen ke `*-banned.txt`
- Domain inbox yang ke-flag TokenHarbor ("email already registered") = tinggal ganti inbox provider / pakai domain sendiri + catch-all