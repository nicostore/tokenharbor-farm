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
const PROVIDER = "tokenharbor"; // built-in 9router provider id (Api Key Providers)

function loadKeys(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("thk_live_"));
}

/** Import daftar key ke 9router (provider tokenharbor). Return {imported, skipped}. */
export function importKeysToRouter(keys, dbPath) {
  const allocated = [...new Set(keys.filter((k) => k && k.startsWith("thk_live_")))];
  if (!allocated.length) return { imported: 0, skipped: 0 };
  if (!dbPath || !existsSync(dbPath)) throw new Error(`DB 9router tidak ada: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  try {
    const existing = new Set(
      db.prepare("SELECT data FROM providerConnections WHERE provider = ?").all(PROVIDER)
        .map((r) => { try { return JSON.parse(r.data).apiKey; } catch { return null; } })
        .filter(Boolean)
    );
    const fresh = allocated.filter((k) => !existing.has(k));
    if (!fresh.length) return { imported: 0, skipped: allocated.length };

    const nowIso = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES (?, ?, 'apikey', ?, NULL, 1, 1, ?, ?, ?)`
    );
    db.exec("BEGIN");
    let n = 0;
    for (const key of fresh) {
      const data = JSON.stringify({
        apiKey: key,
        testStatus: "untested",
        providerSpecificData: {
          connectionProxyEnabled: false,
          connectionProxyUrl: "",
          connectionNoProxy: "",
        },
      });
      insert.run(randomUUID(), PROVIDER, `th-${String(n + 1).padStart(3, "0")}`, data, nowIso, nowIso);
      n++;
    }
    db.exec("COMMIT");
    return { imported: n, skipped: allocated.length - n };
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
  console.log(`Provider: ${PROVIDER} (built-in 9router)`);
  console.log(`Key di file: ${keys.length}`);

  if (DRY) {
    const db = new DatabaseSync(DB);
    const existing = new Set(
      db.prepare("SELECT data FROM providerConnections WHERE provider = ?").all(PROVIDER)
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

  const { imported, skipped } = importKeysToRouter(keys, DB);
  console.log(`✅ Import ${imported} key baru ke 9router (provider tokenharbor, ${skipped} sudah ada). Tidak perlu restart — kebaca live.`);
  console.log(`Cek: GET /v1/models`);
}

// Hanya jalan sebagai CLI (node src/import-9router.mjs) — TIDAK saat di-import
// farm.mjs (auto-import pakai importKeysToRouter langsung).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}