/**
 * Event bus untuk tokenharbor-farm.
 *
 * Semua output ke pengguna lewat EVENT — bukan print langsung. TUI (dan mode
 * headless/non-TTY) subscribe ke bus ini dan me-render sesuai gayanya.
 *
 * Event shape:
 *   { type, ts, ...payload }
 *
 * Types:
 *   - status        ringkasan sesekali (progress)
 *   - key-found     { email, password, api_key, proxy, hybrid }
 *   - proxy-cool    { proxy, level, until }     (cooldown soft/rate)
 *   - proxy-banned  { proxy }
 *   - worker-start  { worker }
 *   - worker-done   { worker, ok, failed }
 *   - error         { message }
 *   - notice        { message }  (info ringan)
 */

const listeners = new Set();

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(type, payload = {}) {
  const ev = { type, ts: Date.now(), ...payload };
  for (const fn of listeners) {
    try { fn(ev); } catch { /* listener bug jangan sampai matiin farm */ }
  }
  return ev;
}

/** Ringkasan status yang dikirim TUI tiap interval refresh. */
export function statusEvent(data) {
  emit("status", data);
}