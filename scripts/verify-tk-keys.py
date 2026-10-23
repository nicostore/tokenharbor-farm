#!/usr/bin/env python3
"""Verifikasi semua connection TK vs upstream TH langsung (tanpa proxy), lalu:
 - 200  -> testStatus='active', hapus lastError/errorCode (entri basi dari 401/402 lama)
 - 401  -> tandai bad (isActive=0, testStatus='invalid-key') + catat
 - lain -> catat apa adanya (402 balance, 404 model, 429 rate)
Free-tier: pakai model ':free' (balance $0 tetap boleh di free tier).
"""
import sqlite3, json, time, urllib.request, urllib.error, collections

DB = "/root/.9router/db/data.sqlite"
MODEL = "deepseek-v4-flash:free"
c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
node = c.execute("SELECT id,name FROM providerNodes WHERE name='TK'").fetchone()
rows = c.execute("SELECT id,name,data FROM providerConnections WHERE provider=?", (node["id"],)).fetchall()
print(f"TK node {node['id']} — {len(rows)} connection", flush=True)

res = collections.Counter(); bad = []; ok_ids = []; other = []
t0 = time.time()
for i, r in enumerate(rows, 1):
    d = json.loads(r["data"]); k = d.get("apiKey", "")
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1}).encode()
    req = urllib.request.Request("https://tokenharbor.ai/v1/chat/completions", data=body,
                                 headers={"Authorization": f"Bearer {k}", "Content-Type": "application/json"})
    code = None; detail = ""
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code; detail = e.read()[:160].decode("utf-8", "replace")
    except Exception as e:
        code = "ERR"; detail = str(e)[:100]
    res[code] += 1
    if code == 200:
        ok_ids.append(r["id"])
    elif code == 401:
        bad.append((r["name"], k[:14], detail[:80]))
    else:
        other.append((r["name"], code, detail[:60]))
    if i % 20 == 0 or i == len(rows):
        print(f"  [{i}/{len(rows)}] {dict(res)} ({int(time.time()-t0)}s)", flush=True)
    time.sleep(1.1)

# ---- tulis hasil ----
for cid in ok_ids:
    row = c.execute("SELECT data FROM providerConnections WHERE id=?", (cid,)).fetchone()
    d = json.loads(row["data"])
    d["testStatus"] = "active"
    for f in ("lastError", "lastErrorAt", "errorCode", "rateLimitedUntil", "backoffLevel"):
        d.pop(f, None)
    c.execute("UPDATE providerConnections SET data=? WHERE id=?", (json.dumps(d), cid))

for name, head, dt in bad:
    row = c.execute("SELECT id,data FROM providerConnections WHERE provider=? AND json_extract(data,'$.apiKey') LIKE ?",
                    (node["id"], head + "%")).fetchone()
    if row:
        d = json.loads(row["data"])
        d["testStatus"] = "invalid-key"; d["lastError"] = f"[401] {dt}"
        c.execute("UPDATE providerConnections SET isActive=0, data=? WHERE id=?", (json.dumps(d), row["id"]))

# ringkasan providerStrategies tetap
c.commit()
print("\n=== HASIL ===")
print("status:", dict(res))
print(f"valid (dibersihin): {len(ok_ids)}")
print(f"401 invalid: {len(bad)}")
for b in bad[:10]: print("   ", b)
print(f"lain: {len(other)}")
for o in other[:10]: print("   ", o)
c.close()
