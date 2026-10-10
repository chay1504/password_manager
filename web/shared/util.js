export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });

export function toB64(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) {
    s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new FormatException('Invalid encoding');
  }
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Compares two equal-purpose strings or byte arrays without early exit. */
export function constantTimeEqual(a, b) {
  const x = typeof a === 'string' ? encoder.encode(a) : a;
  const y = typeof b === 'string' ? encoder.encode(b) : b;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Number of user-visible characters (code points), for password length rules. */
export function charCount(text) {
  return [...text].length;
}

/** An expected, user-explainable failure (bad file, bad input). */
export class FormatException extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatException';
  }
}

/** A message that is safe to show to the user. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}
