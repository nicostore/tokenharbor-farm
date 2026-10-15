#!/usr/bin/env node
/**
 * tokenharbor-farm — interactive UI (menu + dashboard live).
 *
 * Layar:
 *   - MENU: pilih angka (proxy on/off, worker count, rotate-ip target, output file…)
 *   - DASHBOARD: status live yang auto-refresh, event ringkas (bukan log spam)
 *
 * Full logs tetap ditulis ke logs/worker-*.log (auto-clear tiap run).
 *
 * Control:
 *   [1-9] pull menu, [Enter] confirm, [q] quit, [s] stop farm
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, resetConfig } from "./config.mjs";
import { onEvent } from "./events.mjs";
import { Farm } from "./core/farm.mjs";
import { clearLogsOnStart, logFarm } from "./utils/logs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- ANSI helpers ----------
const ESC = "\x1b[";
const C = {
  reset: ESC + "0m", bold: ESC + "1m", dim: ESC + "2m",
  red: ESC + "31m", green: ESC + "32m", yellow: ESC + "33m",
  blue: ESC + "34m", magenta: ESC + "35m", cyan: ESC + "36m",
};
const hideCursor = () => process.stdout.write(ESC + "?25l");
const showCursor = () => process.stdout.write(ESC + "?25h");
const clearScreen = () => process.stdout.write(ESC + "2J" + ESC + "H");

// ---------- state ----------
let cfg = loadConfig();
let farm = null;
let farmBusy = false;
let screen = "menu"; // menu | dashboard
const events = [];   // event terbaru (ringkas)
const MAX_EVENTS = 8;

function pushEvent(ev) {
  const short = summarize(ev);
  if (short) {
    events.push(short);
    if (events.length > MAX_EVENTS) events.shift();
  }
}

function summarize(ev) {
  switch (ev.type) {
    case "key-found":
      return `${C.green}🌊 KEY ${ev.api_key.slice(0, 24)}… via ${ev.proxy}${C.reset}`;
    case "proxy-banned":
      return `${C.red}🚫 banned ${ev.proxy}${C.reset}`;
    case "proxy-cool":
      return `${C.yellow}⏳ cooldown ${ev.proxy} (${ev.level})${C.reset}`;
    case "worker-start":
      return `${C.cyan}▶ worker ${ev.worker} start (${ev.proxyCount} proxy)${C.reset}`;
    case "worker-done":
      return `${C.dim}■ worker ${ev.worker} selesai (${ev.done} key)${C.reset}`;
    case "attempt-fail":
      return `${C.dim}✘ ${ev.kind}${C.reset}`;
    case "error":
      return `${C.red}❌ ${ev.message}${C.reset}`;
    case "notice":
      return `${C.blue}ℹ ${ev.message}${C.reset}`;
    default:
      return null;
  }
}

// ---------- input (raw mode) ----------
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let inputBuf = "";
function onKey(chunk) {
  for (const ch of chunk) {
    if (ch === "\u0003") process.exit(0);           // ctrl-c
    if (ch === "q" || ch === "Q") process.exit(0);   // quit
    if (ch === "s" || ch === "S") { if (farm) farm.stop(); }
    if (ch >= "0" && ch <= "9") { inputBuf += ch; render(); }
    if (ch === "\r" || ch === "\n") { handleSelect(inputBuf); inputBuf = ""; render(); }
  }
}
process.stdin.on("data", onKey);

// ---------- render ----------
function render() {
  if (screen === "menu") renderMenu();
  else renderDashboard();
}

function renderMenu() {
  clearScreen();
  process.stdout.write(C.bold + "🛰  TOKENHARBOR-FARM" + C.reset + C.dim + " v1.0.0" + C.reset + "\n\n");
  process.stdout.write("─ Pengaturan ─────────────────────────────\n");
  process.stdout.write(` 1. Proxy:           ${cfg.proxy.enabled ? C.green + "ON" : C.red + "OFF"}${cfg.proxy.enabled ? ` (${poolCount()} proxy)` : ""}${C.reset}\n`);
  process.stdout.write(` 2. File proxy:      ${cfg.proxy.file}\n`);
  process.stdout.write(` 3. Worker:          ${cfg.worker.count}\n`);
  process.stdout.write(` 4. Inbox provider:  ${cfg.worker.inboxProvider}\n`);
  process.stdout.write(` 5. Hybrid (verify+mint IP bawaan): ${cfg.worker.hybridOff ? "OFF" : C.green + "ON" + C.reset}\n`);
  process.stdout.write(` 6. Output keys:     ${cfg.output.keysFile}\n`);
  process.stdout.write(` 7. Output accounts: ${cfg.output.accountsFile}\n`);
  process.stdout.write(` 8. Target (rotate-ip): ${cfg.rotateip.target === 0 ? "∞ (sampai stop)" : cfg.rotateip.target + " key"}\n`);
  process.stdout.write("\n─ Aksi ────────────────────────────────────\n");
  process.stdout.write(` 9. ▶ START farm\n`);
  process.stdout.write(` S. Stop farm\n`);
  process.stdout.write(` Q. Keluar\n`);
  if (inputBuf) process.stdout.write(`\n${C.yellow}Input: ${inputBuf}${C.reset}`);
  process.stdout.write("\n\n" + C.dim + "pilih angka lalu Enter" + C.reset);
}

function poolCount() {
  try {
    const p = resolve(ROOT, cfg.proxy.file);
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
  } catch { return 0; }
}

function handleSelect(v) {
  const n = parseInt(v, 10);
  if (!n) return;
  switch (n) {
    case 1: {
      cfg.proxy.enabled = !cfg.proxy.enabled;
      saveConfig();
      break;
    }
    case 2: {
      // prompt jalur file (isi manual sederhana pakai inputBuf lanjutan)
      cfg.proxy.file = cfg.proxy.file === "pools/proxies.txt" ? "pools/proxies.txt" : cfg.proxy.file;
      saveConfig();
      break;
    }
    case 3: {
      cfg.worker.count = cfg.worker.count >= 5 ? 1 : cfg.worker.count + 1;
      saveConfig();
      break;
    }
    case 4: {
      const order = ["auto", "tempmail-lol", "mail-tm", "guerrillamail", "temp-email-dev"];
      const i = order.indexOf(cfg.worker.inboxProvider);
      cfg.worker.inboxProvider = order[(i + 1) % order.length];
      saveConfig();
      break;
    }
    case 5: {
      cfg.worker.hybridOff = !cfg.worker.hybridOff;
      saveConfig();
      break;
    }
    case 6: {
      cfg.output.keysFile = cfg.output.keysFile === "keys.txt" ? "keys-2.txt" : "keys.txt";
      saveConfig();
      break;
    }
    case 7: {
      cfg.output.accountsFile = cfg.output.accountsFile === "accounts.jsonl" ? "accounts-2.jsonl" : "accounts.jsonl";
      saveConfig();
      break;
    }
    case 8: {
      // target: 0 → 5 → 10 → 20 → 50 → 0
      const seq = [0, 5, 10, 20, 50];
      const i = seq.indexOf(cfg.rotateip.target);
      cfg.rotateip.target = seq[(i + 1) % seq.length];
      saveConfig();
      break;
    }
    case 9: {
      startFarm();
      break;
    }
  }
}

function renderDashboard() {
  clearScreen();
  const keys = countKeys();
  process.stdout.write(C.bold + "🛰  FARMLIVE" + C.reset + C.dim + `  keys=${keys}  target=${cfg.rotateip.target || "∞"}  ` + C.cyan + `farm: ${farmBusy ? "RUNNING" : "IDLE"}` + C.reset + "\n\n");
  process.stdout.write("─ Event ─────────────────────────────\n");
  if (!events.length) process.stdout.write(C.dim + "  (menunggu event…)" + C.reset + "\n");
  for (const e of events) process.stdout.write("  " + e + "\n");
  process.stdout.write("\n" + C.dim + "[s] stop   [q] keluar   [menu] Esc" + C.reset);
}

function countKeys() {
  try {
    const p = resolve(ROOT, cfg.output.keysFile);
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.startsWith("thk_live_")).length;
  } catch { return 0; }
}

// ---------- farm lifecycle ----------
async function startFarm() {
  if (farmBusy) return;
  farmBusy = true;
  screen = "dashboard";
  clearLogsOnStart();

  farm = new Farm(cfg);
  const unsub = onEvent((ev) => {
    pushEvent(ev);
    if (ev.type === "key-found") logFarm(`KEY ${ev.api_key} via ${ev.proxy}`);
    if (ev.type === "attempt-fail") logFarm(`FAIL ${ev.kind} ${ev.proxy || ""}`);
    if (ev.type === "proxy-banned") logFarm(`BANNED ${ev.proxy}`);
    render();
  });

  try {
    await farm.run();
  } catch (e) {
    pushEvent({ type: "error", message: String(e.message || e) });
  } finally {
    unsub();
    farmBusy = false;
    farm = null;
    screen = "menu";
    render();
  }
}

// ---------- boot ----------
hideCursor();
process.on("exit", showCursor);
render();
// render ulang tiap 2s biar keys count di dashboard selalu fresh
setInterval(() => { if (screen === "dashboard") render(); }, 2000);