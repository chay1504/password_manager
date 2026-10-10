// Eight-digit changing codes: HMAC-SHA-256 over a time counter (RFC 6238 style).
// Matches the earlier Flutter apps, so a paired secret works the same way.
import { constantTimeEqual, encoder } from './util.js';

export const MIN_PERIOD = 5;
export const MAX_PERIOD = 10;
export const DEFAULT_PERIOD = 10;
export const PERIODS = [5, 6, 7, 8, 9, 10];

export function step(ms, period) {
  return Math.floor(ms / (period * 1000));
}

export function secondsLeft(ms, period) {
  return period - (Math.floor(ms / 1000) % period);
}

/** Milliseconds left in the current interval (for smooth countdown rings). */
export function msLeft(ms, period) {
  return period * 1000 - (ms % (period * 1000));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Code for a raw counter value (exported so the RFC 6238 vector can be tested). */
export async function codeForCounter(secret, counter) {
  return codeForStep(await hmacKey(secret), counter);
}

async function codeForStep(key, counter) {
  const block = new ArrayBuffer(8);
  const view = new DataView(block);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, block));
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(value % 100000000).padStart(8, '0');
}

export async function code(secret, ms, period) {
  if (secret.length !== 32) throw new RangeError('Code secret must be 32 bytes');
  if (!PERIODS.includes(period)) throw new RangeError('Period must be 5 to 10 seconds');
  return codeForStep(await hmacKey(secret), step(ms, period));
}

/**
 * Checks a typed code against the current interval of every allowed period,
 * so the interval can be changed in TBD Codes alone. A code is refused if its
 * interval began before the end of the last accepted one (no replay).
 *
 * Returns { ok, end } where `end` is the new "accepted until" time in ms.
 */
export async function verify(input, secret, nowMs, lastAcceptedEnd = 0) {
  if (typeof input !== 'string' || !/^\d{8}$/.test(input)) return { ok: false, reason: 'format' };
  const key = await hmacKey(secret);
  let match = null;
  for (const period of PERIODS) {
    const counter = step(nowMs, period);
    const expected = await codeForStep(key, counter);
    // Evaluate every period so timing does not reveal which one matched.
    if (constantTimeEqual(encoder.encode(input), encoder.encode(expected)) && !match) {
      match = { start: counter * period * 1000, end: (counter + 1) * period * 1000 };
    }
  }
  if (!match) return { ok: false, reason: 'mismatch' };
  if (match.start < lastAcceptedEnd) return { ok: false, reason: 'replay' };
  return { ok: true, end: match.end };
}
