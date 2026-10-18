/**
 * Core provisioning flow: one Token Harbor account + one API key, end to end.
 *
 * HYBRID IP STRATEGY (proven to 50 keys):
 *   - SIGNUP goes through the account's proxy (many fresh egress IPs, so the
 *     signup anti-abuse gate never sees one hot IP).
 *   - VERIFY EMAIL + API-KEY CREATION run from the machine's OWN IP (no proxy)
 *     once a fresh context is created with the signup session's cookies
 *     (storageState). The Vercel Security Checkpoint on /verify-email and the
 *     key-mint dashboard both behave on a clean IP, and this keeps every
 *     account's sensitive finish off the burnable proxy.
 *
 * Each account gets a BRAND-NEW pair of contexts (platform + inbox) so no
 * cookies/cache carry over between accounts, and the caller can pick a fresh
 * proxy per attempt via opts.pickProxy.
 *
 * @module core/provision
 */

import * as tokenharbor from "../tokenharbor/client.mjs";
import { createInbox } from "../inbox/index.mjs";
import { randomKeyName, randomPassword } from "../utils/random.mjs";
import { log } from "../utils/logger.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Block muatan berat (gambar/font/media) — flow cuma butuh DOM text.
// Script & CSS dibiarkan jalan (form React + Turnstile butuh keduanya).
export function leanRoutes(ctx) {
  ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") return route.abort();
    return route.continue();
  });
}

// Desktop Chrome UA — Vercel Security Checkpoint blocks the HeadlessChrome UA
// on /verify-email with an endless "We're verifying your browser" wall.
export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Classify an error so the caller knows whether a retry can help. */
export function classify(err) {
  const m = (err?.message ? err.message : String(err)).toLowerCase();
  if (m.includes("turnstile")) return "turnstile";
  if (m.includes("already registered") || m.includes("already exists") || m.includes("in use"))
    return "email-taken";
  if (m.includes("timed out waiting for the token harbor verification"))
    return "mail-timeout";
  if (m.includes("too many") || m.includes("rate limit") || m.includes("429") || m.includes("throttled") || m.includes("take a breath"))
    return "rate-limit";
  if (m.includes("net::") || m.includes("timeout") || m.includes("econnreset") || m.includes("enotfound"))
    return "network";
  return "other";
}

/**
 * Run one full provisioning attempt inside fresh contexts.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} opts
 * @param {() => ({server:string, username?:string, password?:string}|null)} [opts.pickProxy]  proxy for THIS attempt (null = direct)
 * @param {(storageState:object) => Promise<import('playwright').BrowserContext>} [opts.directContextFactory]  factory for a no-proxy context carrying the signup session
 * @param {(proxyServer:string, errorKind:string) => void} [opts.onProxyFail]  ban hook (rate-limit => never reuse that proxy)
 */
async function attempt(browser, opts, attemptNo) {
  const started = Date.now();
  const keyName = opts.keyName || randomKeyName();
  const password = opts.password || randomPassword(16);

  const pick = opts.pickProxy ? opts.pickProxy() : null;
  if (opts.pickProxy && !pick) {
    throw new Error("worker out of proxies — semua proxy di partisi ini sudah ke-ban");
  }
  const ctxOpts = {
    locale: "en-US",
    // C: viewport kecil — lebih sedikit pixel yang di-rasterize SwiftShader (software GPU),
    // CPU turun tanpa ngaruh ke Turnstile/dashboard (mereka nggak peduli ukuran viewport).
    viewport: { width: 800, height: 600 },
    userAgent: DESKTOP_UA,
    reducedMotion: "reduce",
    ...(pick ? { proxy: pick } : {}),
  };

  const platformContext = await browser.newContext(ctxOpts);
  const platformPage = await platformContext.newPage();
  // Context kedua (inbox) dibuat LAZY — cuma provider yang butuh browser
  // (temp-email.dev). Auto/tempmail-lol/mail-tm/guerrillamail = HTTP API.
  let inboxContext = null;
  let inboxPage = null;
  const ensureInboxPage = async () => {
    if (!inboxPage) {
      inboxContext = await browser.newContext(ctxOpts);
      leanRoutes(inboxContext);
      inboxPage = await inboxContext.newPage();
    }
    return inboxPage;
  };
  let inbox = null;
  let email = null;
  let directContext = null;

  // Lean routing: block berat (gambar/font/media) — flow hanya butuh DOM text.
  // Script & CSS tetap jalan (form + Turnstile butuh).
  leanRoutes(platformContext);

  // Live step callback — worker pakai ini buat tabel dashboard per-action.
  const ip = pick ? pick.server.replace(/^https?:\/\//, "") : "(direct)";
  const step = (label, note = "") => {
    try {
      opts.onStep && opts.onStep({ step: label, ip, note, elapsed: Date.now() - started });
    } catch { /* jangan pernah matiin flow karena UI */ }
  };

  try {
    log.step(`[try ${attemptNo}] starting account${pick ? ` via ${pick.server}` : " (direct)"}`);

    // 1. Fresh inbox.
    step("Start", email ? "" : "");
    // Provider HTTP (auto/tempmail-lol/mail-tm/guerrillamail/custom) TIDAK butuh
    // browser — passing null berarti context inbox tidak pernah dibuat.
    // Cuma temp-email.dev yang butuh page.
    const needsInboxPage = !["auto", "tempmail-lol", "mail-tm", "guerrillamail", "supermail", "tempmailc", "custom", "rest"].includes(opts.inboxProvider);
    inbox = createInbox(opts.inboxProvider, needsInboxPage ? await ensureInboxPage() : null, {
      mailBaseUrl: opts.mailBaseUrl,
      mailboxDomain: opts.mailboxDomain,
      inboxToken: opts.inboxToken,
    });
    const created = await inbox.createInbox();
    email = created.address;
    step("Inbox Ready", email);

    // 2. Sign up (through the proxy whenever one is picked).
    step("Fill Email", email);
    await tokenharbor.signup(platformPage, email, password, opts);
    step("Submit Signup", "");

    // 2a. Delay 2-5s setelah signup: biarin dashboard settle dulu biar tombol
    //     "Enable free models" / "Not now" gak kelewat (kadang keluar telat).
    const settle = 2000 + Math.floor(Math.random() * 3000);
    await sleep(settle);

    // 2b. Enable free models (Turbo ref): jangan biarkan akun dapet plan terbatas.
    let freeModels = false;
    try {
      freeModels = await tokenharbor.enableFreeModels(platformPage);
      if (freeModels) {
        step("Free Models ON", "");
        log.ok("✅ Enabled Free Models (stage 1: after signup)");
      }
    } catch { /* non-blocking */ }
    if (!freeModels) log.warn("Free Models belum enabled (stage 1) — akan dicoba lagi setelah verify");

    // 3. Ask for the verification email.
    step("Request Verify", "");
    await tokenharbor.requestVerificationEmail(platformPage);

    // ===== A: lepas renderer + GPU selama fase TERPANJANG (nunggu email) =====
    // Email di-poll via HTTP (browser nggak dibutuhin), jadi tutup context
    // platform SEKARANG — renderer & swiftshader process mati, CPU turun drastis
    // di fase yang nunggu 1-4 menit. Session cookies disimpan dulu buat hybrid
    // (verify + mint dari IP bawaan).
    const storage = await platformContext.storageState().catch(() => null);
    await platformPage.close().catch(() => {});
    await platformContext.close().catch(() => {});
    if (!storage) throw new Error("storageState gagal setelah signup — session tidak bisa dipakai untuk verify");

    // 4. Read the link from the inbox and follow it (murni HTTP polling).
    step("Wait Verify Mail", email);
    log.step(`waiting for the verification email at ${email}`);
    const link = await inbox.waitForVerificationLink(email, { timeout: opts.timeout });
    log.info("verification link received");
    step("Link Received", link.slice(0, 40));

    // ===== Verify + mint: BISA DI-RETRY dari storage yang sama =====
    // Fase ini TIDAK pakai proxy (hybrid: IP bawaan) — network error transien
    // di sini BUKAN salah proxy. Retry langsung dari cookies, tanpa signup
    // ulang, tanpa ganti proxy. Total 3 percobaan (1 utama + 2 retry).
    const verifyAndMint = async (round) => {
      if (round > 0) {
        log.warn(`verify+mint retry ${round}/2 (storage sama, tanpa ganti proxy)`);
        step("Verify Email (IP bawaan)", link.slice(0, 40));
      }
      // 4b. HYBRID: verify + mint the key from the machine's own IP.
      //     Carry the signup session cookies into a no-proxy context.
      if (opts.directContextFactory && pick) {
        try {
          directContext = await opts.directContextFactory(storage);
          const directPage = await directContext.newPage();
          step("Verify Email (IP bawaan)", link.slice(0, 40));
          await tokenharbor.openVerificationLink(directPage, link);
          step("Email Verified", "");
          // Free models stage-2: kalo belum ON setelah signup, coba lagi sekarang
          // (tombol bisa muncul belakangan setelah email verified).
          if (!freeModels) {
            await sleep(2500);   // dashboard pasca-verify butuh render dulu
            try {
              if (await tokenharbor.enableFreeModels(directPage)) {
                freeModels = true;
                step("Free Models ON", "");
                log.ok("✅ Enabled Free Models (stage 2: after verify)");
              }
            } catch { /* non-blocking */ }
          }
          if (freeModels) log.ok("Free Models enabled ✅ (final)");
          else log.warn("Free Models NOT enabled — tombol tidak muncul di tahap 1 & 2 (account mungkin sudah free default)");
          step("Create API KEY", "");
          const apiKey = await tokenharbor.createApiKey(directPage, keyName);
          step("GET API KEY", apiKey.slice(0, 16));
          await directContext.close().catch(() => {});
          directContext = null;
          log.ok(`hybrid finish di IP bawaan — key=${keyName}`);
          return {
            ok: true,
            email,
            password,
            api_key: apiKey,
            key_name: keyName,
            api_base: "https://tokenharbor.ai/v1",
            email_provider: created.provider,
            proxy: pick.server,
            hybrid: true,
            free_models: freeModels,
            elapsed_ms: Date.now() - started,
            created_at: new Date().toISOString(),
          };
        } catch (err) {
          await directContext?.close().catch(() => {});
          directContext = null;
          log.warn(`hybrid finish gagal (${String(err.message || err).slice(0, 90)}) — fallback verify di proxy`);
        }
      }

      // 4c. Fallback: verify + mint — context BARU dari cookies tersimpan (yang
      //     lama sudah ditutup di fase A). Pakai proxy bila ada (perilaku lama).
      const fbContext = await browser.newContext({ ...ctxOpts, storageState: storage });
      leanRoutes(fbContext);
      const fbPage = await fbContext.newPage();
      try {
        step("Email Verified", "");
        await tokenharbor.openVerificationLink(fbPage, link);
        // Free models stage-2 (jalur fallback proxy) — sama kayak hybrid.
        if (!freeModels) {
          await sleep(2500);
          try {
            if (await tokenharbor.enableFreeModels(fbPage)) {
              freeModels = true;
              step("Free Models ON", "");
              log.ok("✅ Enabled Free Models (stage 2: after verify, via proxy)");
            }
          } catch { /* non-blocking */ }
        }
        if (freeModels) log.ok("Free Models enabled ✅ (final)");
        else log.warn("Free Models NOT enabled — tombol tidak muncul di tahap 1 & 2 (account mungkin sudah free default)");
        step("Create API KEY", "");
        const apiKey = await tokenharbor.createApiKey(fbPage, keyName);
        step("GET API KEY", apiKey.slice(0, 16));

        return {
          ok: true,
          email,
          password,
          api_key: apiKey,
          key_name: keyName,
          api_base: "https://tokenharbor.ai/v1",
          email_provider: created.provider,
          proxy: pick ? pick.server : "(direct)",
          hybrid: false,
          free_models: freeModels,
          elapsed_ms: Date.now() - started,
          created_at: new Date().toISOString(),
        };
      } finally {
        await fbContext.close().catch(() => {});
      }
    };

    // Loop retry verify+mint: network/timeout transien di fase ini bukan salah
    // proxy — ulangi dari cookies yang sama. Rate-limit/email-taken langsung stop.
    let lastVerifyErr = null;
    for (let round = 0; round <= 2; round++) {
      try {
        return await verifyAndMint(round);
      } catch (err) {
        lastVerifyErr = err;
        const k = classify(err);
        if (k === "rate-limit" || k === "email-taken" || k === "mail-timeout") throw err;
        if (round < 2) {
          const backoff = 3000 * (round + 1);
          log.warn(`verify gagal (${k}: ${String(err.message || err).slice(0, 90)}) — retry ${round + 1}/2 dalam ${backoff}ms`);
          await sleep(backoff);
        }
      }
    }
    throw lastVerifyErr;
  } catch (err) {
    const kind = classify(err);
    // Ban hook: tell the caller this proxy is burnt so it is never reused.
    if (kind === "rate-limit" && pick && opts.onProxyFail) {
      try { opts.onProxyFail(pick.server, kind, err.message); } catch { /* ignore */ }
    }
    return {
      ok: false,
      email: email || null,
      password,
      key_name: keyName,
      proxy: pick ? pick.server : "(direct)",
      error: err.message,
      error_kind: kind,
      elapsed_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    };
  } finally {
    if (inbox) await inbox.close().catch(() => {});
    await platformPage.close().catch(() => {});
    await inboxPage?.close().catch(() => {});
    await platformContext.close().catch(() => {});
    await inboxContext?.close().catch(() => {});
    await directContext?.close().catch(() => {});
  }
}

/**
 * Provision a single account with retries and backoff.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} opts  — see attempt() for the full option set.
 * @returns {Promise<object>} result record
 */
export async function provisionOne(browser, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 2;
  let last;
  for (let i = 1; i <= retries + 1; i++) {
    last = await attempt(browser, opts, i);
    if (last.ok) return last;

    if (last.error_kind === "rate-limit") {
      log.warn("rate limit hit — aborting retries for this account");
      return last;
    }
    if (last.error_kind === "email-taken") {
      log.warn("email taken — aborting retries");
      return last;
    }
    if (i <= retries) {
      const backoff = Math.min(8000 * i, 30000);
      log.warn(`attempt ${i} failed (${last.error_kind}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  return last;
}