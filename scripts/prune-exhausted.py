#!/usr/bin/env python3
"""Cek usage tiap key TK (free-tier) lalu hapus connection yang kuotanya HABIS.

Cara baca usage: panggil 1x model ':free' dengan max_tokens=1 → respon bawa header
  x-th-free-used-pct  (persen allowance terpakai)
  x-th-free-resets    (kapan window reset)
  x-th-plan           (free/paid)

Klasifikasi (pesan upstream, bukan cuma kode):
  EXHAUSTED  : 429 + "used this period's free allowance" / pct >= 100  -> HAPUS
  DISABLED   : 403 free_models_disabled / balance_zero                -> HAPUS
  TRANSIENT  : 429 "under heavy load" / "Per-minute rate limit"        -> retry, lalu simpan
  OK         : 200

Pakai:
  python3 scripts/prune-exhausted.py            # DRY (laporan saja)
  python3 scripts/prune-exhausted.py --apply    # hapus yang EXHAUSTED/DISABLED
"""
import sqlite3, json, sys, time, os, collections, urllib.request, urllib.error

DB = "/root/.9router/db/data.sqlite"
MODEL = "deepseek-v4-flash:free"
APPLY = "--apply" in sys.argv
SLEEP = float(os.environ.get("PRUNE_SLEEP", "1.3"))
RETRY_WAIT = float(os.environ.get("PRUNE_RETRY_WAIT", "18"))
ONLY = os.environ.get("PRUNE_ONLY", "").upper()      # mis. TRANSIENT → cuma re-check yang itu
STATE = os.environ.get("PRUNE_STATE", "/root/tokenharbor-farm/logs/prune-last.json")

c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
node = c.execute("SELECT id,name FROM providerNodes WHERE name='TK'").fetchone()
if not node:
    print("node TK tidak ada"); sys.exit(1)
rows = c.execute("SELECT id,name,data FROM providerConnections WHERE provider=?", (node["id"],)).fetchall()

# filter: cuma key yang verdict-nya tertentu di run terakhir (biar throttled bisa diulang)
prev = {}
if os.path.exists(STATE):
    try:
        prev = json.load(open(STATE))
    except Exception:
        prev = {}
if ONLY:
    keep = {k for k, v in prev.items() if v.get("verdict") == ONLY}
    rows = [r for r in rows if r["id"] in keep]
    if not rows:
        print(f"tidak ada key dengan verdict {ONLY} di state — ulang full run"); sys.exit(0)

print(f"TK {node['id']} — {len(rows)} key | mode={'APPLY' if APPLY else 'DRY'} sleep={SLEEP}s"
      + (f" filter={ONLY}" if ONLY else ""), flush=True)


def load_proxies():
    """Proxy pool aktif dari 9router (round-robin) — probe LANGSUNG dari IP VPS
    kena throttle TH 'many free accounts are sharing this network address'."""
    out = []
    try:
        for r in c.execute("SELECT data FROM proxyPools WHERE isActive=1"):
            u = json.loads(r["data"]).get("proxyUrl")
            if u:
                out.append(u)
    except Exception:
        pass
    return out


PROXIES = [] if os.environ.get("PRUNE_DIRECT") == "1" else load_proxies()
_pi = 0


def _opener(proxy):
    if not proxy:
        return urllib.request.build_opener()
    return urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))


def probe(key):
    """Coba beberapa proxy sampai dapat jawaban valid; fallback ke IP bawaan."""
    global _pi
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1}).encode()
    attempts = []
    for _ in range(min(4, max(1, len(PROXIES)))):
        attempts.append(PROXIES[_pi % len(PROXIES)] if PROXIES else None)
        if PROXIES:
            _pi += 1
    if not PROXIES:
        attempts = [None]
    else:
        attempts.append(None)  # terakhir: IP bawaan
    last = ("ERR", {}, "no attempt")
    for proxy in attempts:
        op = _opener(proxy)
        req = urllib.request.Request("https://tokenharbor.ai/v1/chat/completions", data=body,
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with op.open(req, timeout=30) as r:
                h = {k.lower(): v for k, v in r.headers.items()}
                return 200, h, ""
        except urllib.error.HTTPError as e:
            h = {k.lower(): v for k, v in dict(e.headers).items()}
            txt = e.read()[:300].decode("utf-8", "replace")
            last = (e.code, h, txt)
            # 200-level yang kita mau; kalau ini jawaban nyata dari TH (JSON error), berhenti.
            if e.code in (401, 402, 403, 404, 429) and ("{" in txt or "error" in txt.lower()):
                # 429 'network address' / 403 HTML proxy = coba proxy lain
                if e.code == 429 and ("network address" in txt or "Per-minute" in txt or "heavy load" in txt):
                    continue
                if e.code == 403 and "<!DOCTYPE" in txt:
                    continue
                return e.code, h, txt
            continue
        except Exception as e:
            last = ("ERR", {}, str(e)[:100])
            continue
    return last


def classify(code, hdr, err):
    e = (err or "").lower()
    pct = hdr.get("x-th-free-used-pct")
    try:
        pctv = float(pct)
    except Exception:
        pctv = None
    if code == 200:
        if pctv is not None and pctv >= 100:
            return "EXHAUSTED"
        return "OK"
    if code == 403 and ("free_models_disabled" in e or "balance_zero" in e):
        return "DISABLED"
    if code == 429 and ("free allowance" in e or "used this period" in e or "exhausted" in e):
        return "EXHAUSTED"
    if code == 429:
        return "TRANSIENT"
    if code == 401:
        return "AUTH"
    return "OTHER"


stats = collections.Counter()
exhausted, transient, rows_out = [], [], []
for i, r in enumerate(rows, 1):
    d = json.loads(r["data"]); key = d.get("apiKey", "")
    code, hdr, err = probe(key)
    verdict = classify(code, hdr, err)
    # transient → tunggu & ulang sekali
    if verdict == "TRANSIENT":
        time.sleep(RETRY_WAIT)
        code, hdr, err = probe(key)
        verdict = classify(code, hdr, err)
    stats[verdict] += 1
    pct = hdr.get("x-th-free-used-pct", "?")
    resets = (hdr.get("x-th-free-resets", "") or "")[:10]
    rows_out.append((r["name"], verdict, code, pct, resets))
    if verdict in ("EXHAUSTED", "DISABLED"):
        exhausted.append(r["id"])
    elif verdict == "TRANSIENT":
        transient.append(r["name"])
    if i % 10 == 0 or i == len(rows):
        print(f"  [{i}/{len(rows)}] {dict(stats)}", flush=True)
    time.sleep(SLEEP)

print("\n=== RINGKASAN ===")
for k, v in stats.most_common():
    print(f"  {k:10} {v}")

# simpan state (id -> {name, verdict, pct}) biar run berikut bisa filter
os.makedirs(os.path.dirname(STATE), exist_ok=True)
state = dict(prev)
for (cid, nm, verdict, code, pct, resets) in [(r["id"], *t) for r, t in zip(rows, rows_out)]:
    state[cid] = {"name": nm, "verdict": verdict, "code": code, "pct": pct, "resets": resets}
json.dump(state, open(STATE, "w"))
print(f"state -> {STATE}")

print("\n=== USAGE (10 terpakai) ===")
def keypct(t):
    try:
        return -float(t[3])
    except Exception:
        return 0
for n, v, code, pct, resets in sorted(rows_out, key=keypct)[:10]:
    print(f"  {n:12} {v:10} HTTP {code} pct={pct} reset={resets}")

if exhausted:
    print(f"\nakan dihapus: {len(exhausted)} (EXHAUSTED/DISABLED)")
    if APPLY:
        c.executemany("DELETE FROM providerConnections WHERE id=?", [(i,) for i in exhausted])
        c.commit()
        left = c.execute("SELECT COUNT(*) n FROM providerConnections WHERE provider=?", (node["id"],)).fetchone()["n"]
        print(f"✅ dihapus {len(exhausted)} — sisa connection TK: {left}")
    else:
        print("(DRY — tambahkan --apply untuk menghapus)")
else:
    print("\ntidak ada key habis")
c.close()
