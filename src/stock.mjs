#!/usr/bin/env node
/**
 * Auto-stock proxy: fetch dari 4 sumber free list → merge + dedupe → check
 * CONNECT ke target (bukan cuma TCP) → top-up pools file. Tinggal jalanin:
 *
 *   node src/stock.mjs                 -> isi pools/proxies.txt (config default)
 *   node src/stock.mjs 30              -> target minimal 30 alive, isi terus sampai dapet
 *   node src/stock.mjs 30 pools/auto.txt
 *
 * Pool EXISTING dipertahankan (merge, dedupe host:port); proxy banned tidak
 * pernah dimasukkan lagi. Cooldown tidak disentuh (fresh proxy beda hal).
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { loadConfig, abs } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_HOST = process.env.STOCK_TARGET_HOST || "tokenharbor.ai";
const TARGET_PORT = Number(process.env.STOCK_TARGET_PORT || 443);
const CONNECT_TIMEOUT = Number(process.env.STOCK_TIMEOUT || 8000);
const CONCURRENCY = 200;

const SOURCES = [
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&timeout=15000",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSource(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const t = await r.text();
    return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
  } catch { return []; }
}

/** CONNECT ke target via proxy; return true kalau balas 200. Hard timer eksternal
 *  (socket.setTimeout TIDAK fire untuk socket stuck di connecting — SYN di-drop
 *  firewall = tanpa error, tanpa timeout). Race manual wajib. */
function checkProxy(proxy) {
  return new Promise((resolveOne) => {
    const [h, p] = proxy.split(":");
    const sock = net.connect(Number(p), h);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolveOne(ok);
    };
    // Hard timer EKSTERNAL — destroy socket + settle apa pun keadaannya.
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT);
    sock.setTimeout(Math.floor(CONNECT_TIMEOUT / 2), () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => {
      sock.write(`CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\n\r\n`);
    });
    sock.on("data", (d) => {
      const s = d.toString();
      if (/^HTTP\/1\.[01] 200/i.test(s)) done(true);
      else if (/^HTTP\/1\.[01] \d/.test(s)) done(false); // 403/407/502...
      // else: belum lengkap, tunggu data berikutnya
    });
  });
}

/** Batch check dengan concurrency; return array proxy hidup (urutan input). */
async function checkBatch(proxies) {
  const alive = [];
  let i = 0;
  const worker = async () => {
    while (i < proxies.length) {
      const idx = i++;
      if (await checkProxy(proxies[idx])) alive.push(proxies[idx]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return alive;
}

async function main() {
  const minTarget = Number(process.argv[2]) || 0;
  const outArg = process.argv[3];
  const cfg = loadConfig();
  const outFile = abs(outArg || (typeof cfg.proxy?.file === "string" ? cfg.proxy.file : "pools/proxies.txt"));

  console.log(`Auto-stock proxy → ${outFile}`);
  console.log(`Target check: ${TARGET_HOST}:${TARGET_PORT} (timeout ${CONNECT_TIMEOUT / 1000}s)\n`);

  // 1. fetch semua sumber (paralel)
  const raw = (await Promise.all(SOURCES.map(fetchSource))).flat();
  const uniq = [...new Set(raw)];
  console.log(`Sumber: ${SOURCES.length} · raw ${raw.length} · unik ${uniq.length}`);

  // 2. pool existing (merge) — buang yang sudah banned
  let existing = [];
  if (existsSync(outFile)) {
    existing = readFileSync(outFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const bannedSet = new Set();
  const banFile = outFile.replace(/\.txt$/, "") + "-banned.txt";
  if (existsSync(banFile)) {
    for (const l of readFileSync(banFile, "utf8").split(/\r?\n/)) {
      const s = l.trim().split(" ")[0];
      if (s && !s.startsWith("#")) bannedSet.add(s);
    }
  }
  const existingSet = new Set(existing.map((l) => l.split(":")[0] + ":" + l.split(":")[1]).filter((x) => x.length > 3));
  // kandidat baru: unik, belum di pool, belum banned
  let cands = uniq.filter((p) => !existingSet.has(p) && !bannedSet.has(p));

  console.log(`Pool existing: ${existing.length} · banned: ${bannedSet.size} · kandidat baru: ${cands.length}`);

  // 3. kalau masih butuh: check CONNECT
  let added = [];
  const report = (sliceN, aliveN) =>
    console.log(`  check ${sliceN} → ${aliveN} alive (total pool: ${existing.length + added.length}, kandidat sisa: ${cands.length})`);
  if (minTarget > 0) {
    // top-up sampai minTarget total (existing + alive baru) tercapai
    while (cands.length > 0 && existing.length + added.length < minTarget) {
      const slice = cands.splice(0, 400);
      const aliveSlice = await checkBatch(slice);
      // cek ulang banned di antara (check selesai pas ban ke-tulis) — sekali lagi di filter bawah
      added.push(...aliveSlice);
      report(slice.length, aliveSlice.length);
      await sleep(300);
    }
  } else {
    while (cands.length > 0) {
      const slice = cands.splice(0, 400);
      const aliveSlice = await checkBatch(slice);
      added.push(...aliveSlice);
      report(slice.length, aliveSlice.length);
      await sleep(300);
    }
  }

  // 4. merge + tulis (jangan timpa yang existing, jangan masukin banned)
  const finalFilter = (p) => !bannedSet.has(p.split(":")[0] + ":" + p.split(":")[1]) && !bannedSet.has(p);
  const merged = [...existing, ...added].filter((l, i, arr) => arr.indexOf(l) === i);
  writeFileSync(outFile, merged.join("\n") + (merged.length ? "\n" : ""), "utf8");
  console.log(`\nPool akhir: ${merged.length} proxy di ${outFile} (+${added.filter(finalFilter).length} baru)`);
}

main()
  .catch((e) => { console.error("fatal:", e.message); process.exit(1); })
  .finally(() => process.exit(0)); // pastikan exit walau ada socket nyangkut