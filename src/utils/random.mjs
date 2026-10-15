/**
 * Random data generators for account provisioning.
 * Every identifier is drawn from `node:crypto`, never Math.random.
 *
 * @module utils/random
 */

import { randomInt } from "node:crypto";

/** Pick a random element from an array. */
export function pick(arr) {
  return arr[randomInt(arr.length)];
}

/** Random integer in [0, max). */
export function randInt(max) {
  return randomInt(max);
}

const EMAIL_A = [
  "swift", "calm", "bright", "north", "lunar", "ember", "quiet", "vivid",
  "amber", "solar", "frost", "river", "delta", "noble", "crisp", "zesty",
  "misty", "brave", "silent", "rapid", "azure", "coral", "jade", "onyx",
];

const EMAIL_B = [
  "fox", "lynx", "orbit", "pixel", "cedar", "comet", "harbor", "falcon",
  "willow", "quartz", "raven", "maple", "otter", "badger", "heron", "finch",
  "koala", "puma", "wren", "bison", "wolf", "hawk", "kite", "moth",
];

const KEY_ADJ = [
  "prod", "dev", "test", "main", "alpha", "beta", "edge", "core", "data",
  "web", "app", "cli", "ml", "ops", "tool", "lab", "staging", "nightly",
];

const KEY_NOUN = [
  "key", "token", "access", "secret", "agent", "bot", "script", "worker",
  "bridge", "gateway", "runner", "client",
];

/**
 * A random email local-part: two readable words plus a numeric tail,
 * e.g. "swiftfox482913". Lower-case and alphanumeric only, so every
 * disposable-mail provider keeps it verbatim.
 */
export function randomEmailLocal() {
  return `${pick(EMAIL_A)}${pick(EMAIL_B)}${randInt(900000) + 100000}`;
}

/** A random API-key label, e.g. "prod-token-7421". */
export function randomKeyName() {
  return `${pick(KEY_ADJ)}-${pick(KEY_NOUN)}-${randInt(9000) + 1000}`;
}

const PW_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_DIGIT = "23456789";
const PW_SPECIAL = "!@#$%^&*";

/**
 * A password that satisfies Token Harbor's "at least 12 characters" policy
 * and mixes case, digits and a symbol.
 */
export function randomPassword(length = 16) {
  const pools = [PW_LOWER, PW_UPPER, PW_DIGIT, PW_SPECIAL];
  const chars = pools.map((p) => p[randomInt(p.length)]);
  const all = PW_LOWER + PW_UPPER + PW_DIGIT + PW_SPECIAL;
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  // Fisher-Yates so the guaranteed characters are not clustered at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
