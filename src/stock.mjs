#!/usr/bin/env node
/**
 * Auto-stock proxy: harvest dari banyak sumber → filter residential (buang ASN
 * hosting/datacenter) → check CONNECT ke target (bukan cuma TCP) → top-up pool.
 *
 *   node src/stock.mjs                 -> isi pools/proxies.txt (config default)
 *   node src/stock.mjs 30              -> target minimal 30 alive, isi terus sampai dapet
 *   node src/stock.mjs 30 pools/auto.txt
 *
 * Sumber:
 *   1. geonode API — bawa isp/org/asn/anonymityLevel → filter hosting TANPA ip-api.
 *   2. list fresh publik (TheSpeedX, monosans, proxifly, proxyscrape).
 *   3. (opsional) file lokal STOCK_SOURCES (satu URL per baris).
 *
 * Env:
 *   STOCK_RESIDENTIAL=1  -> hanya simpan non-hosting (default: simpan semua, hosting ditandai di urutan belakang)
 *   STOCK_TARGET_HOST    -> default tokenharbor.ai
 *   STOCK_TIMEOUT        -> per-proxy CONNECT timeout ms (default 8000)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { loadConfig, abs } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_HOST = process.env.STOCK_TARGET_HOST || "tokenharbor.ai";
const TARGET_PORT = Number(process.env.STOCK_TARGET_PORT || 443);
const CONNECT_TIMEOUT = Number(process.env.STOCK_TIMEOUT || 8000);
const CONCURRENCY = 250;
const RESIDENTIAL_ONLY = process.env.STOCK_RESIDENTIAL === "1";

// ASN/ISP yang hampir pasti di-blocklist target — buang lebih awal.
const HOSTING_RE = /digitalocean|amazon|aws|google|microsoft|azure|ovh|hetzner|contabo|linode|akamai|vultr|alibaba|oracle|cloudflare|choopa|m247|leaseweb|colocrossing|psychz|hostwinds|hostinger|namecheap|racknerd|quadranet|ionos|gcore|scaleway|upcloud|tencent|huawei|kamatera|servers\.com|datacamp|hosting|datacenter|server|cloud|vps|colo|dedicated|internet solutions|lease|amsterdam|frankfurt|choopa llc/i;

const STATIC_SOURCES = [
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&timeout=15000",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** geonode API — halaman demi halaman, sampai `total`. Return [{p, hosting}]. */
async function fetchGeonode() {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    let j = null;
    try {
      const r = await fetch(
        `https://proxylist.geonode.com/api/proxy-list?limit=500&page=${page}&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (!r.ok) break;
      j = await r.json();
    } catch { break; }
    const data = j?.data || [];
    if (!data.length) break;
    for (const d of data) {
      const ip = d.ip, port = d.port;
      if (!ip || !port) continue;
      const meta = `${d.isp || ""} ${d.org || ""} ${d.asn || ""}`.toLowerCase();
      out.push({ p: `${ip}:${port}`, hosting: HOSTING_RE.test(meta) });
    }
    if (out.length >= (j.total || 0)) break;
    await sleep(150);
  }
  return out;
}

async function fetchStatic(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const t = await r.text();
    return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
  } catch { return []; }
}

/** CONNECT ke target via proxy; true kalau balas 200. Hard timer eksternal
 *  (socket.setTimeout TIDAK fire untuk socket stuck connecting — SYN di-drop
 *  firewall = tanpa error, tanpa timeout). */
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
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT);
    sock.setTimeout(Math.floor(CONNECT_TIMEOUT / 2), () => done(false));
    sock.on("error", () => done(false));
    sock.on("connect", () => {
      sock.write(`CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\n\r\n`);
    });
    sock.on("data", (d) => {
      const s = d.toString();
      if (/^HTTP\/1\.[01] 200/i.test(s)) done(true);
      else if (/^HTTP\/1\.[01] \d/.test(s)) done(false);
    });
  });
}

/** Batch check; return array alive (urutan input). */
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
  console.log(`Target check: ${TARGET_HOST}:${TARGET_PORT} (timeout ${CONNECT_TIMEOUT / 1000}s)`);
  console.log(`Mode: ${RESIDENTIAL_ONLY ? "RESIDENTIAL only" : "semua (hosting di urutan belakang)"}\n`);

  // 1. harvest — geonode (bermeta) + list fresh
  const geo = await fetchGeonode();
  console.log(`geonode: ${geo.length} (residential ${geo.filter((g) => !g.hosting).length})`);

  const extra = (await Promise.all(STATIC_SOURCES.map(fetchStatic))).flat();
  console.log(`list fresh: ${extra.length}`);

  // 2. gabung + dedupe (residential dulu)
  const resiSet = new Set(geo.filter((g) => !g.hosting).map((g) => g.p));
  const hostSet = new Set(geo.filter((g) => g.hosting).map((g) => g.p));
  const known = new Set([...resiSet, ...hostSet, ...extra]);

  // 3. buang yang sudah di pool / banned
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
  const inPool = new Set(existing.map((l) => l.split(":").slice(0, 2).join(":")));
  const isBanned = (p) => bannedSet.has(p) || bannedSet.has(p.split(":").slice(0, 2).join(":"));

  // urutan kandidat: residential dulu, lalu sisanya
  const order = [
    ...[...resiSet],
    ...[...known].filter((p) => !resiSet.has(p) && !hostSet.has(p)),
    ...(RESIDENTIAL_ONLY ? [] : [...hostSet]),
  ];
  const cands = order.filter((p) => !inPool.has(p) && !isBanned(p));
  console.log(`Pool existing: ${existing.length} · banned: ${bannedSet.size} · kandidat baru: ${cands.length}\n`);

  // 4. check CONNECT — verifikasi pool existing DULU, lalu top-up kandidat baru.
  //    Target dihitung dari proxy yang TERVERIFIKASI alive, bukan dari jumlah baris file.
  const report = (n, alive, total) =>
    console.log(`  check ${n} → ${alive} alive (verified ${total}${minTarget ? `/${minTarget}` : ""}, sisa ${cands.length})`);

  let verified = [];
  if (existing.length) {
    const aliveExisting = await checkBatch(existing);
    verified.push(...aliveExisting);
    console.log(`pool existing: ${existing.length} baris → ${aliveExisting.length} alive`);
  }

  let added = [];
  while (cands.length > 0 && (minTarget === 0 || verified.length + added.length < minTarget)) {
    const slice = cands.splice(0, 400);
    const alive = await checkBatch(slice);
    added.push(...alive);
    report(slice.length, alive.length, verified.length + added.length);
    await sleep(200);
  }

  // 5. merge + tulis (existing yang MATI dibuang — file jadi pool alive murni)
  const merged = [...verified, ...added].filter((l, i, arr) => arr.indexOf(l) === i && !isBanned(l));
  writeFileSync(outFile, merged.join("\n") + (merged.length ? "\n" : ""), "utf8");
  console.log(`\nPool akhir: ${merged.length} proxy ALIVE di ${outFile} (+${added.length} baru)`);
}

main()
  .catch((e) => { console.error("fatal:", e.message); process.exit(1); })
  .finally(() => process.exit(0));