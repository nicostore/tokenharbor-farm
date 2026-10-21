#!/usr/bin/env node
/**
 * Import keys hasil farm → 9router (auto). Baca keys.txt (atau file arg),
 * insert providerConnection per key ke node TokenHarbor yang SUDAH ADA di
 * 9router (dideteksi otomatis by prefix TK / baseUrl tokenharbor.ai).
 *
 *   node src/import-9router.mjs                 :: semua key dari cfg keysFile
 *   node src/import-9router.mjs keys-lain.txt   :: file tertentu
 *
 * Env:
 *   ROUTER_DB   path sqlite 9router (default /root/.9router/db/data.sqlite)
 *   ROUTER_PREFIX prefix node (default TK)
 *   ROUTER_DRY=1  cuma lapor, tanpa tulis
 *
 * Idempoten — key yang sudah ada di DB di-skip, aman di-run ulang.
 */
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, abs } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.ROUTER_DB || "/root/.9router/db/data.sqlite";
const PREFIX = process.env.ROUTER_PREFIX || "TK";
const DRY = process.env.ROUTER_DRY === "1";

function loadKeys(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("thk_live_"));
}

async function main() {
  const cfg = loadConfig();
  const keysFile = abs(process.argv[2] || cfg.output.keysFile);
  const keys = loadKeys(keysFile);
  if (!keys.length) { console.log(`Tidak ada key thk_live_ di ${keysFile}`); return; }
  if (!existsSync(DB)) { console.error(`DB 9router tidak ada: ${DB} (set ROUTER_DB)`); process.exit(1); }

  const db = new DatabaseSync(DB);
  const node = db.prepare(
    "SELECT id, name, data FROM providerNodes WHERE type='openai-compatible' AND data LIKE ?"
  ).all(`%"prefix":"${PREFIX}"%`);
  const nodeRow = node[0];
  if (!nodeRow) {
    console.error(`Node 9router dengan prefix ${PREFIX} tidak ditemukan — cek ROUTER_PREFIX`);
    process.exit(1);
  }
  const nodeData = JSON.parse(nodeRow.data);

  // apiKey yang sudah ada di DB (dedupe)
  const existing = new Set(
    db.prepare("SELECT data FROM providerConnections WHERE provider = ?").all(nodeRow.id)
      .map((r) => { try { return JSON.parse(r.data).apiKey; } catch { return null; } })
      .filter(Boolean)
  );

  const fresh = keys.filter((k) => !existing.has(k));
  console.log(`DB: ${DB}`);
  console.log(`Node TokenHarbor: ${nodeRow.id} (${nodeRow.name})`);
  console.log(`Key di file: ${keys.length} · sudah ada di DB: ${keys.length - fresh.length} · baru: ${fresh.length}`);

  if (!fresh.length) { console.log("Tidak ada key baru — selesai."); db.close(); return; }
  if (DRY) { console.log("[DRY] skip insert (set ROUTER_DRY=1 untuk dry-run, unset untuk commit)"); db.close(); return; }

  // backup dulu (sqlite backup via node — aman dengan WAL)
  const backupPath = `${DB}.bak-${Date.now()}`;
  const src = db; // DatabaseSync nggak ada .backup(); pakai copy file (WAL di-flush di close)
  copyFileSync(DB, backupPath);
  console.log(`Backup: ${backupPath}`);

  const nowIso = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data)
     VALUES (?, ?, 'apikey', ?, NULL, 1, 1, ?)`
  );
  const tx = db.exec("BEGIN");
  let n = 0;
  for (const key of fresh) {
    const data = JSON.stringify({
      apiKey: key,
      testStatus: "untested",
      providerSpecificData: {
        prefix: PREFIX,
        apiType: nodeData.apiType || "chat",
        baseUrl: nodeData.baseUrl || "https://tokenharbor.ai/v1",
        nodeName: nodeRow.name,
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
      },
    });
    insert.run(randomUUID(), nodeRow.id, `th-${String(n + 1).padStart(3, "0")}`, data);
    n++;
  }
  db.exec("COMMIT");
  db.close();

  console.log(`✅ Import ${n} key baru ke 9router (node ${nodeRow.name}). Tidak perlu restart — /v1/models langsung kebaca.`);
  console.log(`Cek: GET /v1/models | grep -c '${PREFIX}/'`);
}

main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });