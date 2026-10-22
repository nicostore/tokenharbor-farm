/**
 * Worker proses — di-spawn farm.mjs (1 worker = 1 child node).
 *
 * Tugas:
 *   - milih proxy dari slice-nya (round-robin, skip banned + cooldown)
 *   - jalani provision (hybrid: signup via proxy → verify+mint via IP bawaan)
 *   - kirim EVENT JSON ke stdout (dibaca farm.mjs → bus → TUI)
 *   - tulis FULL LOG ke logs/worker-N.log (auto-clear di awal oleh TUI)
 *
 * JSON event per line ke stdout: {type, ...}
 */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, abs, ensureDirs } from "../config.mjs";
import { provisionOne, DESKTOP_UA, leanRoutes } from "./provision.mjs";
import { logWorker } from "../utils/logs.mjs";

const cfg = loadConfig();
ensureDirs();

const wid = Number(process.argv[2] === "--worker" ? process.argv[3] : 0);
const sliceArg = process.argv[4] === "--proxy-slice" ? process.argv[5] : "[]";
let proxySlice;
try { proxySlice = JSON.parse(sliceArg); } catch { proxySlice = []; }

const OUT = {
  emit(type, payload = {}) {
    process.stdout.write(JSON.stringify({ type, ts: Date.now(), ...payload }) + "\n");
  },
  log(msg) {
    logWorker(wid, msg);
  },
};

// ---- state ----
const bannedFile = abs(cfg.proxy.file.replace(/.txt$/, "") + "-banned.txt");
const cooldownFile = abs(cfg.proxy.file.replace(/.txt$/, "") + "-cooldown.txt");

const banned = new Set();
const cooldown = new Map(); // proxy -> until

function loadBans() {
  try {
    for (const l of readFileSync(bannedFile, "utf8").split(/\r?\n/)) {
      const s = l.trim();
      if (s && !s.startsWith("#")) banned.add(s.split(" ")[0]);
    }
  } catch { /* belum ada */ }
}
function loadCooldowns() {
  try {
    for (const l of readFileSync(cooldownFile, "utf8").split(/\r?\n/)) {
      const [server, rest] = l.trim().split(/\s+#\s*/);
      if (!server) continue;
      const until = Number((rest || "").split(" ").pop() || 0);
      if (until > Date.now()) cooldown.set(server, until);
    }
  } catch { /* belum ada */ }
}

const target = Number(process.env.TH_TARGET || 0);

// Hard timeout per attempt: kalau ada await yang hang (proxy macet, page nggak
// settle, browser beku), worker TIDAK boleh diam selamanya di step yang sama.
// Default 9 menit — cukup buat signup + tunggu email (timeoutMs=4m) + verify.
const attemptTimeoutMs = Number(process.env.TH_ATTEMPT_TIMEOUT || 540000);

// ---- proxy picker (global-ish: baca banned/cooldown tiap manggil, biar lintas worker sinkron) ----
let idx = 0;
function pickProxy() {
  if (!cfg.proxy.enabled || !proxySlice.length) return null;
  for (let tries = 0; tries < proxySlice.length * 2; tries++) {
    const p = proxySlice[idx % proxySlice.length];
    idx++;
    // refresh bans tiap beberapa kali (file dibaca murah)
    if (tries % 5 === 0) { loadBans(); loadCooldowns(); }
    if (banned.has(p)) continue;
    const until = cooldown.get(p);
    if (until && until > Date.now()) continue;
    return p;
  }
  return null; // abis — worker bilang "out of proxies"
}

function markProxyFail(proxy, errMsg) {
  const msg = String(errMsg || "").toLowerCase();
  const isSoft = /throttled|take a breath|a bit fast/i.test(msg);
  const now = Date.now();
  if (isSoft) {
    cooldown.set(proxy, now + (cfg.proxy.cooldownSoftSec || 90) * 1000);
    appendFileSync(cooldownFile, `${proxy}  # soft ${now + (cfg.proxy.cooldownSoftSec || 90) * 1000}\n`);
    OUT.emit("proxy-cool", { proxy, level: "soft" });
    OUT.log(`⏳ cooldown soft: ${proxy}`);
    return;
  }
  const failCount = countFail(proxy) + 1;
  if (failCount >= (cfg.proxy.maxFailsBeforeBan || 3)) {
    banned.add(proxy);
    appendFileSync(bannedFile, `${proxy}  # rate-limit permanent ${new Date().toISOString()}\n`);
    OUT.emit("proxy-banned", { proxy });
    OUT.log(`🚫 BANNED: ${proxy} (3x rate-limit)`);
    return;
  }
  const mins = failCount === 1 ? (cfg.proxy.cooldownRateMin || 30) : (cfg.proxy.cooldownRateRepeatMin || 60);
  cooldown.set(proxy, now + mins * 60 * 1000);
  appendFileSync(cooldownFile, `${proxy}  # rate ${now + mins * 60 * 1000}\n`);
  OUT.emit("proxy-cool", { proxy, level: `rate(${mins}m)` });
  OUT.log(`⏳ cooldown ${mins}m: ${proxy}`);
}

function countFail(proxy) {
  // baca file cooldown, hitung berapa kali rate-fail (line '# rate')
  try {
    const t = readFileSync(cooldownFile, "utf8");
    return t.split(/\r?\n/).filter((l) => l.startsWith(proxy + "  # rate")).length;
  } catch { return 0; }
}

// Heartbeat: bukti worker masih hidup — TUI pakai ini buat deteksi HANG
// (worker yang nggak ngirim apa pun > 120s = beku, ditandai merah).
const heartbeat = setInterval(() => OUT.emit("alive", { worker: wid }), 30000);

// ---- main loop ----
async function main() {
  loadBans();
  loadCooldowns();
  OUT.emit("worker-start", { worker: wid, proxyCount: proxySlice.length });

  let done = 0;
  try {
    for (;;) {
      if (target > 0 && done >= target) break;

      const proxy = pickProxy();
      if (proxy === null && cfg.proxy.enabled && proxySlice.length) {
        OUT.emit("error", { message: `worker ${wid}: semua proxy di slice cooldown/banned` });
        OUT.log("⚠️ out of proxies (semua cooldown/banned)");
        break;
      }

      OUT.emit("attempt", { worker: wid, proxy: proxy || "(direct)" });
      OUT.log(`── account via ${proxy || "(direct)"} ──`);

      // FRESH browser per account (anti-flag) — launch, provision, close.
      // Windows: pakai Microsoft Edge bawaan (channel msedge) — TANPA download
      // Chromium, jadi setup instan. Fallback ke chromium terinstall.
      let browser = null;
      try {
        const { chromium } = await import("playwright");

        const LAUNCH_ARGS = [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--enable-unsafe-swiftshader",
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--ignore-gpu-blocklist",
          "--enable-webgl",
          "--disable-blink-features=AutomationControlled",
          // hemat CPU/RAM: matiin fitur gak kepake di headless farm
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-extensions",
          "--disable-features=Translate,OptimizationHints,MediaRouter",
          "--no-first-run",
          "--no-default-browser-check",
        ];

        try {
          browser = await chromium.launch({ channel: "msedge", headless: true, args: LAUNCH_ARGS });
        } catch {
          try {
            browser = await chromium.launch({ channel: "chrome", headless: true, args: LAUNCH_ARGS });
          } catch {
            browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
          }
        }

        const r = await Promise.race([
          provisionOne(browser, {
            inboxProvider: cfg.worker.inboxProvider,
            inboxToken: cfg.worker.inboxToken,
            mailBaseUrl: cfg.worker.mailBaseUrl,
            mailboxDomain: cfg.worker.mailboxDomain,
            timeout: cfg.worker.timeoutMs,
            retries: cfg.worker.retriesPerAccount,
            ...(proxy
              ? { pickProxy: () => parseProxyLine(proxy), onProxyFail: (srv, kind, errMsg) => markProxyFail(srv, errMsg) }
              : {}),
            directContextFactory: cfg.worker.hybridOff
              ? null
              : async (storage) => {
                  const ctx = await browser.newContext({
                    locale: "en-US",
                    userAgent: DESKTOP_UA,
                    storageState: storage,
                    reducedMotion: "reduce",
                    // TANPA proxy — verify + API key dari IP asli/bawaan mesin.
                  });
                  leanRoutes(ctx);
                  return ctx;
                },
            onStep: (s) => OUT.emit("step", s),
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`attempt timeout ${Math.round(attemptTimeoutMs / 60000)}m — worker di-recover`)), attemptTimeoutMs)
          ),
        ]);

        if (r.ok) {
          done++;
          OUT.emit("key-found", {
            email: r.email,
            password: r.password,
            api_key: r.api_key,
            key_name: r.key_name,
            proxy: r.proxy,
            hybrid: r.hybrid,
            free_models: r.free_models,
          });
          OUT.log(`✅ KEY: ${r.api_key.slice(0, 24)}… via ${r.proxy}${r.free_models ? " (free models)" : ""}`);
        } else {
          // rate-limit sudah di-mark oleh onProxyFail di dalam provision
          // (attempt() -> opts.onProxyFail) — jangan mark dobel di sini,
          // biar fail-count proxy nggak cepat naik & ke-ban lebih awal.
          OUT.emit("attempt-fail", { worker: wid, kind: r.error_kind, proxy: r.proxy });
          OUT.log(`✘ ${r.error_kind}: ${(r.error || "").slice(0, 100)}`);
        }
      } catch (e) {
        OUT.emit("attempt-fail", { worker: wid, kind: "crash", proxy: proxy || "(direct)", err: String(e.message || e).slice(0, 150) });
        OUT.log(`❌ ${e.message}`);
      } finally {
        await browser?.close().catch(() => {});
      }
    }
  } catch (e) {
    OUT.emit("error", { message: String(e.message || e).slice(0, 200) });
    OUT.log(`❌ ${e.message}`);
  }
  OUT.emit("worker-done", { worker: wid, done });
  clearInterval(heartbeat);
  process.exit(0);
}

function parseProxyLine(str) {
  const [h, p, u, pa] = str.split(":");
  const o = { server: `http://${h}:${p}` };
  if (u) o.username = u;
  if (pa) o.password = pa;
  return o;
}

main();