/**
 * Settings + persistence for tokenharbor-farm.
 *
 * ALL user-configurable knobs live here and persist to config.json so a
 * re-run keeps the same settings. The TUI edits this; the farm reads it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "config.json");

export const DEFAULTS = {
  proxy: {
    enabled: true,          // proxy on/off (off = direct IP bawaan)
    file: "pools/proxies.txt",
    cooldownSoftSec: 90,
    cooldownRateMin: 30,
    cooldownRateRepeatMin: 60,
    maxFailsBeforeBan: 3,
    autoStock: true,        // ON = isi ulang pool otomatis kalau menipis (fetch free list + check CONNECT)
  },
  worker: {
    count: 3,
    retriesPerAccount: 1,   // B: tiap retry = browser baru (full launch + swiftshader) — 1 retry cukup
    timeoutMs: 240000,
    inboxProvider: "auto",   // auto | tempmail-lol | mail-tm | guerrillamail | supermail | tempmailc | temp-email-dev
    inboxToken: "",          // tempmailc trial code (100 request) — isi di config.json lokal, jangan di-commit
    hybridOff: false,        // false = verify+mint pakai IP bawaan (recommended)
  },
  output: {
    keysFile: "keys.txt",
    accountsFile: "accounts.jsonl",
    logsDir: "logs",
    clearLogsOnStart: true,  // auto-clear full logs tiap run
  },
  router: {
    autoImport: false,       // ON = tiap key mint langsung di-import ke 9router (wajib 9router lokal)
    dbPath: "",              // kosong = auto-detect (/root/.9router/db/data.sqlite, %USERPROFILE%\.9router\...)
  },
  rotateip: {
    target: 0,               // 0 = sampai stop manual; N = sampai N key
  },
};

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  let disk = {};
  try {
    disk = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* first run — use defaults */ }
  // deep-merge disk over defaults
  const merged = JSON.parse(JSON.stringify(DEFAULTS));
  for (const sect of Object.keys(DEFAULTS)) {
    if (disk[sect] && typeof disk[sect] === "object") {
      merged[sect] = { ...merged[sect], ...disk[sect] };
    }
  }
  cached = merged;
  return cached;
}

export function saveConfig(cfg = cached) {
  cached = cfg;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function getConfig() {
  return loadConfig();
}

/** Cari path DB 9router secara cross-platform (Windows + Linux). */
export function findRouterDb() {
  const cfg = loadConfig();
  if (cfg.router?.dbPath) return cfg.router.dbPath;
  const candidates = [
    "/root/.9router/db/data.sqlite",
    resolve(process.env.USERPROFILE || process.env.HOME || "~", ".9router", "db", "data.sqlite"),
    resolve(process.env.USERPROFILE || "", ".9router", "data.sqlite"),
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

export function resetConfig() {
  cached = JSON.parse(JSON.stringify(DEFAULTS));
  saveConfig();
  return cached;
}

export function rootPath() {
  return ROOT;
}

export function abs(p) {
  if (!p) return null;
  return resolve(ROOT, p);
}

export function ensureDirs() {
  const cfg = loadConfig();
  for (const d of [cfg.output.logsDir, dirname(abs(cfg.proxy.file))]) {
    if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
  }
}