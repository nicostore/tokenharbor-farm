#!/usr/bin/env node
/**
 * tokenharbor-farm — interactive UI (menu + dashboard live).
 *
 * Input flow:
 *   - mode MENU     : ketik angka [1-9] lalu Enter (aksi langsung / masuk prompt)
 *   - mode PROMPT   : ketik nilai lalu Enter (Backspace hapus, Esc batal)
 *   - mode DASHBOARD: [s] stop, [q] keluar
 *
 * Layar ANSI minimal, render penuh per keystroke. Tidak ada flicker abuse.
 * Non-TTY (piped): render sekali lalu jalan sebagai headless-status.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.mjs";
import { onEvent } from "./events.mjs";
import { Farm } from "./core/farm.mjs";
import { clearLogsOnStart, logFarm } from "./utils/logs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ESC = "\x1b[";
const C = {
  reset: ESC + "0m", bold: ESC + "1m", dim: ESC + "2m",
  red: ESC + "31m", green: ESC + "32m", yellow: ESC + "33m",
  blue: ESC + "34m", cyan: ESC + "36m", gray: ESC + "90m",
};
const hideCursor = () => process.stdout.write(ESC + "?25l");
const showCursor = () => process.stdout.write(ESC + "?25h");
const clearScreen = () => process.stdout.write(ESC + "2J" + ESC + "H");
// Alternate screen buffer: render di buffer terpisah, swap saat keluar —
// menghilangkan flicker scrollback & redraw yang kelihatan.
const ENTER_ALT = ESC + "?1049h";
const LEAVE_ALT = ESC + "?1049l";

// Throttle render: event bisa datang ratusan/detik (burst), kita coalesce
// jadi maks 1 render per 60ms — layar tetap responsif, CPU nggak kepakai.
let dirty = false;
let renderTimer = null;
function scheduleRender() {
  if (dirty) return;          // sudah ada render terjadwal
  dirty = true;
  renderTimer = setTimeout(() => {
    dirty = false;
    renderTimer = null;
    render();
  }, 60);
}

let cfg = loadConfig();
let farm = null;
let farmBusy = false;
let farmStartedAt = 0;

let mode = "menu";       // menu | prompt | dashboard
let promptField = null;  // key PROMPTS
let promptInitial = "";
let promptInput = "";
let menuBuf = "";

const events = [];
const MAX_EVENTS = 10;

// ---------- field prompt ----------
const PROMPTS = {
  proxyFile: {
    label: "File proxy (path relatif/absolut). Contoh: pools/proxies.txt",
    parse: (v) => { const s = v.trim(); if (!s) throw new Error("path tidak boleh kosong"); return s; },
    apply: (v) => { cfg.proxy.file = v; saveConfig(); },
  },
  workerCount: {
    label: "Jumlah worker (1-50)",
    parse: (v) => { const n = parseInt(v, 10); if (!n || n < 1 || n > 50) throw new Error("harus angka 1-50"); return n; },
    apply: (v) => { cfg.worker.count = v; saveConfig(); },
  },
  keysFile: {
    label: "File output keys. Contoh: keys.txt",
    parse: (v) => v.trim() || "keys.txt",
    apply: (v) => { cfg.output.keysFile = v; saveConfig(); },
  },
  accountsFile: {
    label: "File output accounts. Contoh: accounts.jsonl",
    parse: (v) => v.trim() || "accounts.jsonl",
    apply: (v) => { cfg.output.accountsFile = v; saveConfig(); },
  },
  target: {
    label: "Target rotate-ip (0 = sampai stop, N = sampai N key). Contoh: 50",
    parse: (v) => { const n = parseInt(v, 10); if (Number.isNaN(n) || n < 0) throw new Error("harus angka >= 0"); return n; },
    apply: (v) => { cfg.rotateip.target = v; saveConfig(); },
  },
};

// ---------- summarize event ----------
function summarize(ev) {
  switch (ev.type) {
    case "key-found": return `${C.green}🌊 KEY ${(ev.api_key || "").slice(0, 24)}… via ${ev.proxy}${C.reset}`;
    case "proxy-banned": return `${C.red}🚫 banned ${ev.proxy}${C.reset}`;
    case "proxy-cool": return `${C.yellow}⏳ cooldown ${ev.proxy} (${ev.level})${C.reset}`;
    case "worker-start": return `${C.cyan}▶ worker ${ev.worker} start (${ev.proxyCount} proxy)${C.reset}`;
    case "worker-done": return `${C.dim}■ worker ${ev.worker} selesai (${ev.done} key)${C.reset}`;
    case "attempt-fail": return `${C.gray}✘ ${ev.kind}${C.reset}`;
    case "error": return `${C.red}❌ ${ev.message}${C.reset}`;
    case "notice": return `${C.blue}ℹ ${ev.message}${C.reset}`;
    default: return null;
  }
}

function pushEvent(ev) {
  const s = summarize(ev);
  if (s) { events.push(s); if (events.length > MAX_EVENTS) events.shift(); }
}

// ---------- input ----------
let tty = true;
try { process.stdin.setRawMode(true); } catch { tty = false; }
process.stdin.resume();
process.stdin.setEncoding("utf8");

function onKey(chunk) {
  for (const ch of chunk) {
    if (ch === "\u0003") process.exit(0); // ctrl-c
    if (mode === "prompt") {
      if (ch === "\r" || ch === "\n") return confirmPrompt();
      if (ch === "\x7f" || ch === "\x08") { promptInput = promptInput.slice(0, -1); }
      else if (ch === "\u001b") { promptInput = ""; mode = "menu"; }        // Esc batal
      else if (ch >= " " && ch !== "\u001b") promptInput += ch;
      render();
      continue;
    }
    if (mode === "dashboard") {
      if (ch === "s" || ch === "S") { if (farm) farm.stop(); }
      if (ch === "q" || ch === "Q") process.exit(0);
      continue;
    }
    // menu
    if (ch === "q" || ch === "Q") process.exit(0);
    if (ch === "s" || ch === "S") { if (farm) farm.stop(); }
    if (ch === "\r" || ch === "\n") { flushMenu(); continue; }
    if (ch >= "0" && ch <= "9") { menuBuf += ch; render(); }
  }
}
process.stdin.on("data", onKey);

function flushMenu() {
  const n = parseInt(menuBuf, 10);
  menuBuf = "";
  if (n && !Number.isNaN(n)) handleMenu(n);
  render();
}

function handleMenu(n) {
  switch (n) {
    case 1: cfg.proxy.enabled = !cfg.proxy.enabled; saveConfig(); break;
    case 2: enterPrompt("proxyFile", cfg.proxy.file); break;
    case 3: enterPrompt("workerCount", String(cfg.worker.count)); break;
    case 4: {
      const order = ["auto", "tempmail-lol", "mail-tm", "guerrillamail", "supermail", "tempmailc", "temp-email-dev"];
      const i = order.indexOf(cfg.worker.inboxProvider);
      cfg.worker.inboxProvider = order[(i + 1) % order.length];
      saveConfig();
      break;
    }
    case 5: cfg.worker.hybridOff = !cfg.worker.hybridOff; saveConfig(); break;
    case 6: enterPrompt("keysFile", cfg.output.keysFile); break;
    case 7: enterPrompt("accountsFile", cfg.output.accountsFile); break;
    case 8: enterPrompt("target", String(cfg.rotateip.target)); break;
    case 9: startFarm(); break;
    default: break;
  }
}

function enterPrompt(field, initial) {
  promptField = field;
  promptInitial = initial || "";
  promptInput = "";   // mulai kosong; initial cuma placeholder
  mode = "prompt";
  render();
}

function confirmPrompt() {
  const f = PROMPTS[promptField];
  // kosong -> pakai placeholder (nilai lama) tanpa di-parse ulang
  const raw = promptInput.trim() === "" ? promptInitial : promptInput;
  try {
    const v = f.parse(raw);
    f.apply(v);
    mode = "menu";
  } catch (e) {
    events.push(`${C.red}⚠ ${e.message}${C.reset}`);
    if (events.length > MAX_EVENTS) events.shift();
    mode = "menu";
  }
  render();
}

// ---------- render ----------
function poolCount() {
  try {
    const p = resolve(ROOT, cfg.proxy.file);
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
  } catch { return 0; }
}

function countKeys() {
  try {
    const p = resolve(ROOT, cfg.output.keysFile);
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.startsWith("thk_live_")).length;
  } catch { return 0; }
}

function countBanned() {
  try {
    const p = resolve(ROOT, cfg.proxy.file.replace(/\.txt$/, "") + "-banned.txt");
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).length;
  } catch { return 0; }
}

function countCooldown() {
  try {
    const p = resolve(ROOT, cfg.proxy.file.replace(/\.txt$/, "") + "-cooldown.txt");
    if (!existsSync(p)) return 0;
    const now = Date.now();
    return readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => {
        if (!l.trim()) return false;
        const until = Number((l.split("#").pop() || "").trim() || 0);
        return until > now;
      }).length;
  } catch { return 0; }
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

function banner() {
  return C.bold + "🛰 TOKENHARBOR-FARM" + C.reset + C.dim + " v1.0.0" + C.reset;
}

function render() {
  clearScreen();
  if (!tty) { renderStatic(); return; }
  if (mode === "prompt") renderPrompt();
  else if (mode === "dashboard") renderDashboard();
  else renderMenu();
}

// mode non-TTY (piped): print statis sekali, jangan spam ANSI
function renderStatic() {
  let s = banner() + "\n\n";
  s += `  Proxy: ${cfg.proxy.enabled ? "ON" : "OFF"} | workers: ${cfg.worker.count} | target: ${cfg.rotateip.target || "∞"}\n`;
  s += `  keys: ${countKeys()}\n`;
  process.stdout.write(s + "\n");
}

function renderMenu() {
  let s = banner() + "\n\n";
  s += `${C.bold}─ Pengaturan ─${C.reset} ${sep().slice(0, Math.max(termWidth() - 16, 10))}\n`;
  s += ` 1. Proxy           ${cfg.proxy.enabled ? C.green + "ON " : C.red + "OFF"}${C.reset}${cfg.proxy.enabled ? ` (${poolCount()} proxy di pool)` : " (direct IP bawaan)"}\n`;
  s += ` 2. File proxy      ${trunc(cfg.proxy.file, Math.max(termWidth() - 20, 20))}\n`;
  s += ` 3. Jumlah worker   ${cfg.worker.count}\n`;
  s += ` 4. Inbox provider  ${cfg.worker.inboxProvider}\n`;
  s += ` 5. Hybrid (verify+mint IP bawaan)  ${cfg.worker.hybridOff ? C.red + "OFF" : C.green + "ON"}${C.reset}\n`;
  s += ` 6. Output keys     ${trunc(cfg.output.keysFile, Math.max(termWidth() - 20, 20))}\n`;
  s += ` 7. Output accounts ${trunc(cfg.output.accountsFile, Math.max(termWidth() - 20, 20))}\n`;
  s += ` 8. Target rotate-ip ${cfg.rotateip.target === 0 ? "∞ (sampai stop)" : cfg.rotateip.target + " key"}\n`;
  s += `\n${C.bold}─ Aksi ─${C.reset} ${sep().slice(0, Math.max(termWidth() - 10, 10))}\n`;
  s += ` ${C.green}9. ▶ START farm${C.reset}\n`;
  s += ` S. Stop farm   Q. Keluar\n`;
  if (events.length) {
    s += `\n${C.bold}─ Event terakhir ─${C.reset} ${sep().slice(0, Math.max(termWidth() - 20, 10))}\n`;
    for (const e of events.slice(-6)) s += "  " + trunc(e, Math.max(termWidth() - 4, 20)) + "\n";
  }
  s += "\n" + C.gray + "ketik angka lalu Enter" + C.reset;
  if (menuBuf) s += "\n\n" + C.yellow + "> " + menuBuf + C.reset;
  process.stdout.write(s + "\n");
  hideCursor();
}

function renderPrompt() {
  const f = PROMPTS[promptField];
  let s = banner() + "\n\n";
  s += C.bold + f.label + C.reset + "\n\n";
  s += "> " + (promptInput || C.gray + promptInitial + C.reset) + C.dim + "▏" + C.reset + "\n\n";
  s += C.gray + "Enter = simpan (kosong = pakai nilai lama)   Backspace = hapus   Esc = batal" + C.reset + "\n";
  process.stdout.write(s);
  showCursor();
}

// State tabel live per worker
const workerRows = new Map(); // wid -> { ip, step, note, since, status }

function setWorkerStep(ev) {
  const wid = ev.worker || 0;
  const row = workerRows.get(wid) || { ip: "", step: "…", note: "", since: Date.now(), status: "idle" };
  if (ev.type === "step") {
    row.ip = ev.ip || row.ip;
    row.step = ev.step || row.step;
    row.note = ev.note || "";
    row.since = ev.ts || Date.now();
    row.status = "work";
  } else if (ev.type === "worker-start") {
    row.ip = ev.proxyCount ? "…" : "(direct)";
    row.step = "Starting";
    row.since = ev.ts || Date.now();
    row.status = "work";
  } else if (ev.type === "key-found") {
    row.step = "✅ KEY!";
    row.note = (ev.api_key || "").slice(0, 20);
    row.status = "done";
  } else if (ev.type === "attempt-fail") {
    row.step = "✘ " + (ev.kind || "fail");
    row.note = "";
    row.status = "fail";
  } else if (ev.type === "worker-done") {
    row.step = "Selesai";
    row.status = "idle";
  }
  workerRows.set(wid, row);
}

function fmtElapsed(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

// ----- responsive helpers -----
function termWidth() {
  const w = process.stdout.columns;
  return w && w > 40 ? w : 80;   // fallback konservatif: 80 kolom (worst-case aman)
}
function trunc(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)) + "…";
}
function sep() { return "─".repeat(Math.max(termWidth() - 1, 20)); }

function renderDashboard() {
  const keys = countKeys();
  const W = termWidth();
  // proporsi kolom: worker(4) ip(30%) event(22%) note(sisa) time(8)
  const wIp = Math.max(12, Math.floor(W * 0.30));
  const wStep = Math.max(10, Math.floor(W * 0.20));
  const wNote = Math.max(8, W - (4 + 3 + wIp + 3 + wStep + 3 + 8 + 1));
  const wTime = 8;
  const tgt = cfg.rotateip.target || "∞";
  const elapsed = farmStartedAt ? Date.now() - farmStartedAt : 0;
  const rate = elapsed > 5000 ? ((keys / elapsed) * 3600000).toFixed(0) : "-";
  const banned = countBanned();
  const cool = countCooldown();
  const done = [...workerRows.values()].filter((r) => r.status === "done").length;
  const alive = [...workerRows.values()].filter((r) => r.status === "work").length;

  let s = banner() + "\n\n";
  // Bar statistik (responsif): rate/jam, durasi, banned, cooldown, provider
  const statPad = Math.max(termWidth() - 4, 30);
  s += `  ${C.bold}🔑 ${keys}/${tgt}${C.reset}  ${C.green}▲ ${rate}/jam${C.reset}  ${C.dim}${fmtDur(elapsed)}${C.reset}`;
  s += `  ${C.red}🚫 ${banned}${C.reset}  ${C.yellow}⏳ ${cool}${C.reset}`;
  s += `  ${C.cyan}▸ ${cfg.worker.inboxProvider}${C.reset}  ` + (farmBusy ? C.green + "● RUNNING" : C.yellow + "○ IDLE") + C.reset + "\n";
  s += `  ${C.dim}${"─".repeat(statPad)}${C.reset}\n`;
  // Tabel live per worker (responsif)
  s += `${C.bold}${pad("W", 2)}   ${pad("IP", wIp)} ${pad("Event", wStep)} ${pad("Note", wNote)} ${pad("Time", wTime)}  ${C.dim}${alive} hidup / ${done} selesai${C.reset}\n`;
  s += sep() + "\n";
  const ws = [...workerRows.keys()].sort((a, b) => a - b);
  if (!ws.length) s += C.gray + "  (menunggu worker…)" + C.reset + "\n";
  for (const wid of ws) {
    const r = workerRows.get(wid);
    const color = r.status === "done" ? C.green : r.status === "fail" ? C.red : r.status === "idle" ? C.gray : C.cyan;
    s += `${pad(wid, 2)}   ${pad(trunc(r.ip || "...", wIp), wIp)} ${color}${pad(trunc(r.step, wStep), wStep)}${C.reset} ${pad(trunc(r.note || "", wNote), wNote)} ${pad(fmtElapsed(r.since), wTime)}\n`;
  }
  s += "\n" + C.gray + "[s] stop   [q] keluar" + C.reset;
  process.stdout.write(s + "\n");
  hideCursor();
}

// ---------- farm ----------
async function startFarm() {
  if (farmBusy) return;
  farmBusy = true;
  farmStartedAt = Date.now();
  mode = "dashboard";
  events.length = 0;
  clearLogsOnStart();

  farm = new Farm(cfg);
  const unsub = onEvent((ev) => {
    setWorkerStep(ev);
    pushEvent(ev);
    if (ev.type === "key-found") logFarm(`KEY ${ev.api_key} via ${ev.proxy}`);
    if (ev.type === "attempt-fail") logFarm(`FAIL ${ev.kind} ${ev.proxy || ""}`);
    if (ev.type === "proxy-banned") logFarm(`BANNED ${ev.proxy}`);
    scheduleRender();
  });

  try {
    await farm.run();
  } catch (e) {
    pushEvent({ type: "error", message: String(e.message || e) });
  } finally {
    unsub();
    farmBusy = false;
    farm = null;
    mode = "menu";
    render();
  }
}

// ---------- boot ----------
hideCursor();
process.stdout.write(ENTER_ALT);
process.on("exit", () => {
  showCursor();
  process.stdout.write(LEAVE_ALT);
});
// Resize window -> UI langsung menyesuaikan lebar kolom (no restart).
process.stdout.on("resize", () => { if (mode !== "dashboard" || farmBusy) render(); });
render();
// tick ringan 1s: cuma nge-schedule kalau dashboard (elapsed time jalan);
// render tetap di-coalesce 60ms, nggak redraw penuh terus.
setInterval(() => { if (mode === "dashboard") scheduleRender(); }, 1000);