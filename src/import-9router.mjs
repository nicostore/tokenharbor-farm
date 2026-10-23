#!/usr/bin/env node
/**
 * Import keys hasil farm → 9router (auto). Baca keys.txt (atau file arg),
 * insert providerConnection per key ke provider BAWAAN 9router "tokenharbor"
 * (registry id — sama seperti bikin connection manual via UI Api Key Providers,
 * field `provider: "tokenharbor"`, TANPA row providerNodes tambahan).
 *
 *   node src/import-9router.mjs                 :: semua key dari cfg keysFile
 *   node src/import-9router.mjs keys-lain.txt   :: file tertentu
 *
 * Env:
 *   ROUTER_DB      path sqlite 9router (default /root/.9router/db/data.sqlite)
 *   ROUTER_DRY=1   cuma lapor, tanpa tulis
 *
 * Idempoten — dedupe by apiKey, aman di-run ulang.
 */
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, abs, findRouterDb } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.env.ROUTER_DRY === "1";

/**
 * Tentukan provider id target: node CUSTOM user (prefix/name 'TK') > bawaan 'tokenharbor'.
 * Override lewat config router.providerId atau env TH_PROVIDER.
 * @returns {{id: string, label: string, custom: boolean}}
 */
export function resolveProvider(db, cfg = loadConfig()) {
  const explicit = process.env.TH_PROVIDER || cfg.router?.providerId;
  const nodes = db.prepare("SELECT id, name, data FROM providerNodes").all();
  const build = (n) => {
    let d = {};
    try { d = JSON.parse(n.data || "{}"); } catch { /* */ }
    return {
      id: n.id,
      label: `custom node ${n.name} (${d.prefix || "?"})`,
      custom: true,
      // custom node WAJIB bawa baseUrl/prefix/nodeName/apiType di psd tiap connection —
      // tanpa itu routing per-connection + tombol test dashboard gagal (401/404).
      psd: {
        prefix: d.prefix || "",
        apiType: d.apiType || "chat",
        baseUrl: d.baseUrl || "",
        nodeName: n.name || "",
      },
    };
  };
  if (explicit) {
    const hit = nodes.find((n) => n.id === explicit);
    if (hit) return build(hit);
    return { id: explicit, label: explicit, custom: true, psd: {} };
  }
  for (const n of nodes) {
    let d = {};
    try { d = JSON.parse(n.data || "{}"); } catch { /* */ }
    const nm = String(n.name || "").trim().toUpperCase();
    const pfx = String(d.prefix || "").trim().toUpperCase();
    if (nm === "TK" || pfx === "TK") return build(n);
  }
  return { id: "tokenharbor", label: "bawaan tokenharbor", custom: false, psd: {} };
}

/** Proxy pool aktif, urut stabil (round-robin deterministik). */
function activePools(db) {
  try {
    return db.prepare("SELECT id FROM proxyPools WHERE isActive=1 ORDER BY rowid").all().map((r) => r.id);
  } catch { return []; }
}

/**
 * Import daftar key ke 9router (provider custom TK / bawaan tokenharbor).
 * Kalau applyProxy: tiap key di-bind round-robin ke proxyPools aktif
 * (connectionProxyEnabled=true + proxyPoolId) → 1 key 1 egress IP.
 * Return {imported, skipped, provider, proxied}.
 */
export function importKeysToRouter(keys, dbPath, opts = {}) {
  const allocated = [...new Set(keys.filter((k) => k && k.startsWith("thk_live_")))];
  if (!allocated.length) return { imported: 0, skipped: 0, provider: null, proxied: 0 };
  if (!dbPath || !existsSync(dbPath)) throw new Error(`DB 9router tidak ada: ${dbPath}`);

  const cfg = loadConfig();
  const wantProxy = opts.applyProxy ?? (process.env.ROUTER_NO_PROXY === "1" ? false : cfg.router?.applyProxy !== false);

  const db = new DatabaseSync(dbPath);
  try {
    const provider = resolveProvider(db, cfg);
    const existing = new Set(
      db.prepare("SELECT data FROM providerConnections WHERE provider = ?").all(provider.id)
        .map((r) => { try { return JSON.parse(r.data).apiKey; } catch { return null; } })
        .filter(Boolean)
    );
    const fresh = allocated.filter((k) => !existing.has(k));
    if (!fresh.length) return { imported: 0, skipped: allocated.length, provider, proxied: 0 };

    const pools = wantProxy ? activePools(db) : [];
    const nowIso = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES (?, ?, 'apikey', ?, NULL, 1, 1, ?, ?, ?)`
    );
    let rr = existing.size; // offset biar round-robin nyambung
    const seq = existing.size; // nomor key lanjut biar nama unik
    db.exec("BEGIN");
    let n = 0, proxied = 0;
    for (const key of fresh) {
      const psd = {
        ...(provider.psd || {}),
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
      };
      if (pools.length) {
        psd.connectionProxyEnabled = true;
        psd.proxyPoolId = pools[rr % pools.length];
        proxied++; rr++;
      }
      const data = JSON.stringify({ apiKey: key, testStatus: "untested", providerSpecificData: psd });
      insert.run(randomUUID(), provider.id, `th-${String(seq + n + 1).padStart(3, "0")}`, data, nowIso, nowIso);
      n++;
    }
    db.exec("COMMIT");
    return { imported: n, skipped: allocated.length - n, provider, proxied };
  } finally {
    db.close();
  }
}

async function main() {
  const cfg = loadConfig();
  const keysFile = abs(process.argv[2] || cfg.output.keysFile);
  const keys = loadKeys(keysFile);
  if (!keys.length) { console.log(`Tidak ada key thk_live_ di ${keysFile}`); return; }

  const DB = process.env.ROUTER_DB || findRouterDb();
  if (!DB) { console.error("DB 9router tidak ditemukan (set ROUTER_DB atau isi config router.dbPath)"); process.exit(1); }

  console.log(`DB: ${DB}`);
  console.log(`Key di file: ${keys.length}`);

  const db0 = new DatabaseSync(DB);
  const provider = resolveProvider(db0, cfg);
  const nPools = activePools(db0).length;
  db0.close();
  const wantProxy = process.env.ROUTER_NO_PROXY === "1" ? false : cfg.router?.applyProxy !== false;
  console.log(`Provider: ${provider.label} — ${provider.id}`);
  console.log(`Proxy: ${wantProxy ? `${nPools} pool aktif (round-robin per key)` : "OFF"}`);

  if (DRY) {
    const db = new DatabaseSync(DB);
    const existing = new Set(
      db.prepare("SELECT data FROM providerConnections WHERE provider = ?").all(provider.id)
        .map((r) => { try { return JSON.parse(r.data).apiKey; } catch { return null; } })
        .filter(Boolean)
    );
    db.close();
    const fresh = keys.filter((k) => !existing.has(k));
    console.log(`Sudah ada di DB: ${keys.length - fresh.length} · baru: ${fresh.length}`);
    console.log("[DRY] skip insert (unset ROUTER_DRY untuk commit)");
    return;
  }

  // backup dulu
  const backupPath = `${DB}.bak-${Date.now()}`;
  copyFileSync(DB, backupPath);
  console.log(`Backup: ${backupPath}`);

  const { imported, skipped, proxied } = importKeysToRouter(keys, DB);
  console.log(`✅ Import ${imported} key ke ${provider.label} (${skipped} sudah ada) · proxy: ${proxied}/${imported}. Live — nggak perlu restart.`);
  console.log(`Cek: GET /v1/models`);
}

function loadKeys(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("thk_live_"));
}

// Hanya jalan sebagai CLI (node src/import-9router.mjs) — TIDAK saat di-import
// farm.mjs (auto-import pakai importKeysToRouter langsung).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}