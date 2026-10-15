/**
 * tokenharbor-farm — orchestrator inti (farm engine).
 *
 * Dipanggil dari TUI (atau CLI langsung) dan menjalankan worker farm.
 * Semua output lewat event bus (src/events.mjs); full logs ke file.
 *
 * Mode:
 *   - target N key (rotate-ip): jalan sampai N key terkumpul
 *   - target 0: jalan sampai di-stop (SIGINT / pemanggil)
 *
 * Proxy:
 *   - pool dari config.proxy.file (host:port[:user:pass] per line)
 *   - cooldown bertingkat: soft (90s) / rate (30m, 60m) / ban permanen (3x)
 *   - "proxy on/off" — kalau off, semua jalan direct (IP bawaan)
 *
 * Hybrid (default, config.worker.hybridOff=false):
 *   signup via proxy → verify + mint API key via IP Bawaan (cookie di-bawa)
 *   Ini kombinasi yang menghasilkan key (signup anti-abuse + vercel checkpoint lolos).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, abs, ensureDirs } from "../config.mjs";
import { emit, onEvent } from "../events.mjs";
import { logFarm } from "../utils/logs.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
const NODE = process.execPath;

export class Farm {
  constructor(cfg = loadConfig()) {
    this.cfg = cfg;
    this.children = new Map(); // wid -> child
    this.stopped = false;
    this.keyCount = 0;
    this.startedAt = Date.now();
  }

  loadPool() {
    const file = abs(this.cfg.proxy.file);
    if (!this.cfg.proxy.enabled) {
      emit("notice", { message: "proxy OFF — semua akun jalan direct (IP bawaan)" });
      return [];
    }
    if (!existsSync(file)) {
      emit("error", { message: `pool proxy tidak ada: ${file} — set lewat menu (proxy: on/off)` });
      return null;
    }
    const lines = readText(file).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) {
      emit("error", { message: `pool proxy kosong: ${file}` });
      return null;
    }
    return lines;
  }

  /** Hitung total key terbaru dari file output. */
  recountKeys() {
    const f = abs(this.cfg.output.keysFile);
    try {
      const t = readText(f);
      this.keyCount = t.split(/\r?\n/).filter((l) => l.startsWith("thk_live_")).length;
    } catch { this.keyCount = 0; }
    return this.keyCount;
  }

  /** Jalan terus sampai target tercapai / di-stop. */
  async run() {
    ensureDirs();
    const cfg = this.cfg;
    const workers = Math.max(1, cfg.worker.count);
    const target = cfg.rotateip.target; // 0 = sampai stop

    this.recountKeys();
    if (target > 0 && this.keyCount >= target) {
      emit("notice", { message: `target ${target} key sudah tercapai (${this.keyCount}) — stop` });
      return;
    }

    const pool = this.loadPool();
    if (pool === null) return;

    logFarm(`=== FARM START: workers=${workers} target=${target || "∞"} proxy=${cfg.proxy.enabled ? pool.length : "OFF"} ===`);

    // Bangun worker: 1 worker = 1 child node yang jalanin provision loop.
    // Proxy di-partisi per worker (disjoint); ban global lewat file bersama.
    const perWorker = pool.length ? Math.ceil(pool.length / workers) : 0;
    for (let w = 0; w < workers; w++) {
      const slice = pool.length ? pool.slice(w * perWorker, Math.min(pool.length, (w + 1) * perWorker)) : [];
      this.spawnWorker(w, slice);
    }

    // monitor: cek target tercapai / semua worker mati
    while (!this.stopped) {
      await sleep(5000);
      this.recountKeys();
      if (target > 0 && this.keyCount >= target) {
        emit("notice", { message: `🎯 target ${target} key TERCAPAI (${this.keyCount})` });
        this.stopChildren("target");
        break;
      }
      const alive = [...this.children.values()].filter((c) => c.exitCode === null).length;
      if (alive === 0 && this.children.size > 0) {
        emit("error", { message: "semua worker mati — stop" });
        break;
      }
    }

    this.stopChildren("end");
    // emit status final
    emit("status", {
      keys: this.recountKeys(),
      workers: 0,
      target,
      elapsed: Math.round((Date.now() - this.startedAt) / 1000),
    });
    logFarm(`=== FARM END: keys=${this.recountKeys()} ===`);
  }

  spawnWorker(wid, proxySlice) {
    const args = [
      resolve(ROOT, "src/core/worker.mjs"),
      "--worker", String(wid),
      "--proxy-slice", JSON.stringify(proxySlice),
    ];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, TH_FARM_ROOT: ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(wid, child);

    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          this.handleWorkerEvent(wid, ev);
        } catch { /* not json — ignore */ }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("exit", (code) => {
      emit("worker-done", { worker: wid, code });
      this.children.delete(wid);
    });

    emit("worker-start", { worker: wid, proxies: proxySlice.length });
    logFarm(`worker ${wid} spawned (${proxySlice.length} proxy)`);
  }

  handleWorkerEvent(wid, ev) {
    // Forwards event dari worker ke bus utama.
    emit(ev.type, { ...ev, worker: wid });
    if (ev.type === "key-found") this.keyCount++;
  }

  stopChildren(reason) {
    this.stopped = true;
    for (const [, c] of this.children) {
      try { c.kill("SIGTERM"); } catch { /* */ }
    }
    // grace, lalu hard kill
    setTimeout(() => {
      for (const [, c] of this.children) {
        try { c.kill("SIGKILL"); } catch { /* */ }
      }
    }, 2000);
    logFarm(`stop children (${reason})`);
  }

  stop() {
    this.stopChildren("user");
  }
}

function readText(p) {
  return readFileSync(p, "utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CLI direct: `node src/core/farm.mjs --target 10` = headless farm
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const withArgs = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--target") withArgs.target = Number(process.argv[++i] || 0);
  }
  if (withArgs.target !== undefined) loadConfig().rotateip.target = withArgs.target;
  process.on("SIGINT", () => process.exit(0));
  // headless: print semua event ke stdout (TUI nggak lewat jalur ini)
  onEvent((ev) => {
    const t = new Date(ev.ts).toISOString().slice(11, 19);
    let line = `[${t}] ${ev.type}`;
    if (ev.type === "key-found") line = `[${t}] 🌊 KEY ${ev.api_key.slice(0, 24)}… via ${ev.proxy}`;
    else if (ev.type === "proxy-banned") line = `[${t}] 🚫 banned ${ev.proxy}`;
    else if (ev.type === "proxy-cool") line = `[${t}] ⏳ cooldown ${ev.proxy} (${ev.level})`;
    else if (ev.type === "worker-start") line = `[${t}] ▶ worker ${ev.worker} start (${ev.proxyCount} proxy)`;
    else if (ev.type === "worker-done") line = `[${t}] ■ worker ${ev.worker} selesai (${ev.done} key)`;
    else if (ev.type === "attempt-fail") line = `[${t}] ✘ ${ev.kind} ${ev.proxy || ""}`;
    else if (ev.type === "error") line = `[${t}] ❌ ${ev.message}`;
    else if (ev.type === "notice") line = `[${t}] ℹ ${ev.message}`;
    console.log(line);
  });
  const farm = new Farm(loadConfig());
  farm.run().then(() => process.exit(0));
}