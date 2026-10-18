#!/usr/bin/env node
/**
 * Recheck akun yang SUDAH ADA (accounts.jsonl): login ke tiap akun, cek tombol
 * "Enable free models" di dashboard — kalau muncul, klik (aktifkan); kalau nggak
 * ada = akun memang sudah free. Record yang ke-fix di-update free_models:true
 * langsung di accounts.jsonl (in-place rewrite).
 *
 * Pakai:
 *   node src/recheck.mjs            — semua akun di accounts.jsonl
 *   node src/recheck.mjs 10         — cuma 10 akun pertama (limit)
 *   node src/recheck.mjs 10 3       — 10 akun, 3 worker paralel
 *
 * Browser: FRESH per akun (anti-flag), headless, msedge→chrome→chromium,
 * LAUNCH_ARGS hemat CPU sama kayak farm. Login + cek dari IP bawaan (hybrid).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./utils/logger.mjs";
import { loadConfig } from "./config.mjs";
import { login, enableFreeModels } from "./tokenharbor/client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : resolve(ROOT, p));

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--ignore-gpu-blocklist",
  "--enable-webgl",
  "--disable-blink-features=AutomationControlled",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-extensions",
  "--disable-features=Translate,OptimizationHints,MediaRouter",
  "--no-first-run",
  "--no-default-browser-check",
];

async function launchBrowser() {
  const { chromium } = await import("playwright");
  const tries = [
    { channel: "msedge" },
    { channel: "chrome" },
    {},
  ];
  let lastErr;
  for (const o of tries) {
    try {
      return await chromium.launch({ ...o, headless: true, args: LAUNCH_ARGS });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function loadAccounts(cfg, limit) {
  const af = abs(cfg.output.accountsFile);
  if (!existsSync(af)) return [];
  const rows = readFileSync(af, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  for (const line of rows) {
    try {
      const rec = JSON.parse(line);
      if (rec.email && rec.password) out.push(rec);
    } catch { /* baris korup — skip */ }
  }
  return limit > 0 ? out.slice(0, limit) : out;
}

/** Parse rec.proxy -> Playwright proxy object (atau null kalau kosong/invalid). */
function toProxy(proxyStr) {
  if (!proxyStr) return null;
  let s = String(proxyStr).trim();
  if (!s) return null;
  let username = "";
  let password = "";
  let server = s;
  // http://host:port:user:pass atau http://user:pass@host:port
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/^https?:\/\/(?:([^:@\/]+):([^@\/]+)@)?([^\/]+)/i);
    if (m) {
      username = m[1] || "";
      password = m[2] || "";
      server = s.replace(/^https?:\/\//i, "http://").replace(/(?:([^:@\/]+):([^@\/]+)@)/, "");
      if (m[1] && m[2]) server = `http://${m[3]}`;
    }
  } else {
    // host:port:user:pass atau host:port
    const parts = s.split(":");
    if (parts.length === 4) {
      server = `http://${parts[0]}:${parts[1]}`;
      username = parts[2];
      password = parts[3];
    } else if (parts.length === 2) {
      server = `http://${parts[0]}:${parts[1]}`;
    } else {
      return null; // format nggak dikenal
    }
  }
  return { server, username: username || undefined, password: password || undefined };
}

// ---- pool proxy (sama kayak signup: pools/proxies.txt + banned/cooldown) ----
function loadPool(cfg) {
  const pf = abs(cfg.proxy.file);
  if (!existsSync(pf)) return [];
  return readFileSync(pf, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
function loadExcluded(cfg) {
  const base = cfg.proxy.file.replace(/\.txt$/, "");
  const banned = new Set();
  const cooldown = new Map();
  try {
    for (const l of readFileSync(abs(base + "-banned.txt"), "utf8").split(/\r?\n/)) {
      const s = l.trim();
      if (s && !s.startsWith("#")) banned.add(s.split(" ")[0]);
    }
  } catch { /* belum ada */ }
  try {
    for (const l of readFileSync(abs(base + "-cooldown.txt"), "utf8").split(/\r?\n/)) {
      const [server, rest] = l.trim().split(/\s+#\s*/);
      if (!server) continue;
      const until = Number((rest || "").split(" ").pop() || 0);
      if (until > Date.now()) cooldown.set(server, until);
    }
  } catch { /* belum ada */ }
  return { banned, cooldown };
}

// Pool picker global: round-robin, skip banned + cooldown (file dibaca ulang tiap 5 panggilan).
let poolIdx = 0;
const makePoolPicker = (cfg) => {
  const pool = loadPool(cfg);
  let excl = loadExcluded(cfg);
  let calls = 0;
  return {
    poolSize: pool.length,
    next() {
      if (!cfg.proxy.enabled || !pool.length) return null;
      if (++calls % 5 === 0) excl = loadExcluded(cfg);
      for (let tries = 0; tries < pool.length * 2; tries++) {
        const p = pool[poolIdx % pool.length];
        poolIdx++;
        if (excl.banned.has(p)) continue;
        const until = excl.cooldown.get(p);
        if (until && until > Date.now()) continue;
        return p;
      }
      return null;
    },
  };
};

async function recheckOne(browser, rec, pool) {
  // Proxy dari POOL aja (sama kayak signup): pools/proxies.txt round-robin.
  const poolProxy = pool ? pool.next() : null;
  const proxyCfg = poolProxy ? { src: poolProxy, toPlaywright: toProxy(poolProxy) } : null;
  const baseOpts = {
    viewport: { width: 800, height: 600 },
    reducedMotion: "reduce",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  };
  const tryWith = async (proxy) => {
    const ctx = await browser.newContext({ ...baseOpts, ...(proxy ? { proxy } : {}) });
    const page = await ctx.newPage();
    try {
      await page.route("**/*", (r) => {
        const t = r.request().resourceType();
        if (t === "image" || t === "font" || t === "media") return r.abort();
        return r.continue();
      });
      await login(page, rec.email, rec.password);
      await sleep(2500); // dashboard settle
      // Cek quota free tier dari endpoint internal (fast path — nggak perlu UI).
      const quota = await page
        .evaluate(() =>
          fetch("/api/me/free-tier", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
        .catch(() => null);
      return { quota, page, ctx };
    } catch (e) {
      await ctx.close().catch(() => {});
      throw e;
    }
  };

  // 1) coba via pool; 2) kalau gagal (timeout/auth), fallback IP bawaan.
  let attempt = null;
  let viaProxy = false;
  let viaPool = false;
  if (proxyCfg) {
    try {
      attempt = await tryWith(proxyCfg.toPlaywright);
      viaProxy = true;
      viaPool = true;
    } catch (proxyErr) {
      log.warn(`${rec.email}: proxy ${proxyCfg.src} gagal (${String(proxyErr.message || proxyErr).slice(0, 80)}) — fallback IP bawaan`);
      attempt = await tryWith(null);
    }
  } else {
    attempt = await tryWith(null);
  }
  const { page, ctx, quota } = attempt;
  try {
    const wasFree = rec.free_models === true;
    const enabled = await enableFreeModels(page);
    if (enabled && !wasFree) {
      rec.free_models = true;
      return { status: "fixed", rec, quota, viaProxy, viaPool };
    }
    if (enabled && wasFree) return { status: "already", rec, quota, viaProxy, viaPool };
    return { status: wasFree ? "already" : "absent", rec, quota, viaProxy, viaPool }; // tombol tak muncul = sudah free
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const cfg = loadConfig();
  const limit = Number(process.argv[2]) || 0;
  const workers = Math.min(Number(process.argv[3]) || 1, 8);
  const accounts = loadAccounts(cfg, limit);
  if (!accounts.length) {
    console.log("Tidak ada akun di " + abs(cfg.output.accountsFile) + " (butuh email+password).");
    return;
  }
  console.log(`Recheck ${accounts.length} akun (${workers} worker paralel) — file: ${abs(cfg.output.accountsFile)}\n`);

  const browser = await launchBrowser();
  const pool = makePoolPicker(cfg);
  if (pool.poolSize) log.info(`pool: ${pool.poolSize} proxy (${cfg.proxy.file})`);
  const results = [];
  let i = 0;
  const next = async () => {
    while (i < accounts.length) {
      const idx = i++;
      const rec = accounts[idx];
      try {
        const r = await recheckOne(browser, rec, pool);
        results.push({ idx, ...r });
        const icon = r.status === "fixed" ? "✅ FIXED" : r.status === "already" ? "✔ sudah" : "○ absent";
        const via = r.viaProxy ? "via pool" : "IP bawaan";
        const q = r.quota;
        const qs = q
          ? `quota ${q.req_used ?? "?"} req (${q.used_pct ?? "?"}%), reset ${(q.reset_at || "?").slice(0, 10)}${q.exhausted ? " ⚠ EXHAUSTED" : ""}`
          : "quota n/a";
        log.info(`[${idx + 1}/${accounts.length}] ${rec.email} — ${icon} free models (${via}) · ${qs}`);
      } catch (e) {
        results.push({ idx, status: "error", error: String(e.message || e) });
        log.warn(`[${idx + 1}/${accounts.length}] ${rec.email} — ❌ ${String(e.message || e).slice(0, 140)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, next));
  await browser.close().catch(() => {});

  // In-place update accounts.jsonl untuk yang ke-fix (rewrite bersih).
  const fixed = results.filter((r) => r.status === "fixed");
  if (fixed.length) {
    const af = abs(cfg.output.accountsFile);
    const lines = readFileSync(af, "utf8").split(/\r?\n/);
    for (const r of fixed) {
      const i = r.idx;
      let n = 0;
      for (let li = 0; li < lines.length; li++) {
        if (!lines[li].trim()) continue;
        try {
          const rec = JSON.parse(lines[li]);
          if (rec.email && rec.password) {
            if (n === i) {
              lines[li] = JSON.stringify(r.rec);
              break;
            }
            n++;
          }
        } catch { /* korup */ }
      }
    }
    writeFileSync(af, lines.join("\n"), "utf8");
    log.ok(`accounts.jsonl di-update: ${fixed.length} akun sekarang free_models:true`);
  }

  const errs = results.filter((r) => r.status === "error");
  const absent = results.filter((r) => r.status === "absent");
  const already = results.filter((r) => r.status === "already");

  // keys-recheck.txt: key dari akun yang quota-nya BELUM habis (exhausted=false,
  // used_pct < 100). Snapshot fresh tiap run — file di-overwrite.
  const healthy = results.filter((r) => r.quota && !r.quota.exhausted && (r.quota.used_pct ?? 100) < 100);
  if (healthy.length) {
    const kf = resolve(ROOT, "keys-recheck.txt");
    const lines = healthy
      .map((r) => accounts[r.idx]?.api_key || "")
      .filter(Boolean);
    if (lines.length) {
      writeFileSync(kf, [...new Set(lines)].join("\n") + "\n", "utf8");
      log.ok(`keys-recheck.txt ditulis: ${[...new Set(lines)].length} key dengan quota tersisa`);
    }
  } else {
    log.warn("keys-recheck.txt tidak ditulis — tidak ada akun dengan quota tersisa (semua exhausted / quota n/a)");
  }

  console.log(`\n=== Ringkasan ===`);
  console.log(`  ✅ Di-fix (baru diaktifkan): ${fixed.length}`);
  console.log(`  ✔ Sudah free models:        ${already.length}`);
  console.log(`  ○ Tombol absent (free):     ${absent.length}`);
  console.log(`  ❌ Gagal login/cek:          ${errs.length}`);
  if (errs.length) {
    console.log("\nGagal:");
    for (const r of errs) console.log(`  - ${accounts[r.idx].email}: ${String(r.error).slice(0, 120)}`);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
