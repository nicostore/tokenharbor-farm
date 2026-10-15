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
  },
  worker: {
    count: 3,
    retriesPerAccount: 2,
    timeoutMs: 240000,
    inboxProvider: "auto",   // auto | tempmail-lol | mail-tm | guerrillamail | temp-email-dev
    hybridOff: false,        // false = verify+mint pakai IP bawaan (recommended)
  },
  output: {
    keysFile: "keys.txt",
    accountsFile: "accounts.jsonl",
    logsDir: "logs",
    clearLogsOnStart: true,  // auto-clear full logs tiap run
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