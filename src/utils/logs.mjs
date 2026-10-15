/**
 * Logging untuk tokenharbor-farm.
 *
 * FULL LOGS selalu ditulis ke file (logs/worker-N.log atau logs/farm.log),
 * dan di-clear otomatis tiap run (config.output.clearLogsOnStart).
 * Layar TUI cuma render EVENT (status singkat), bukan baris log ini.
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function logPath(name) {
  const cfg = loadConfig();
  const d = resolve(ROOT, cfg.output.logsDir || "logs");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return resolve(d, name);
}

export function clearLogsOnStart() {
  const cfg = loadConfig();
  if (!cfg.output.clearLogsOnStart) return;
  const d = resolve(ROOT, cfg.output.logsDir || "logs");
  if (existsSync(d)) writeFileSync(resolve(d, "farm.log"), "", "utf8");
}

let currentWorkers = [];

export function logWorker(workerIndex, msg) {
  const f = logPath(`worker-${workerIndex}.log`);
  // size guard: jangan sampai log membengkak tak terkendali (crash-loop)
  try {
    if (existsSync(f) && statSync(f).size > 5 * 1024 * 1024) writeFileSync(f, "", "utf8");
  } catch { /* ignore */ }
  try { appendFileSync(f, `${stamp()} ${msg}\n`, "utf8"); } catch { /* disk penuh dkk */ }
}

export function logFarm(msg) {
  const f = logPath("farm.log");
  try { appendFileSync(f, `${stamp()} ${msg}\n`, "utf8"); } catch { /* ignore */ }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}