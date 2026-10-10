// Pairing code: copied once from TBD Vault and pasted into TBD Codes.
// Format: TBD1-XXXXXXXX-XXXXXXXX-... (Crockford base32 of version, secret,
// interval, and a 16-bit checksum so a typo is caught instead of mis-pairing).
import { FormatException } from './util.js';
import { MAX_PERIOD, MIN_PERIOD } from './otp.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'TBD1';

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const raw of text) {
    const c = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new FormatException('Pairing code has an invalid character');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

export function encodePairing(secret, period) {
  if (secret.length !== 32 || period < MIN_PERIOD || period > MAX_PERIOD) {
    throw new RangeError('Invalid pairing details');
  }
  const body = Uint8Array.of(1, ...secret, period);
  const crc = crc16(body);
  const text = base32(Uint8Array.of(...body, crc >> 8, crc & 255));
  return `${PREFIX}-${text.match(/.{1,8}/g).join('-')}`;
}

/** Returns { secret, period }. Throws FormatException with a friendly message. */
export function decodePairing(input) {
  const cleaned = String(input).trim().toUpperCase();
  if (!cleaned.startsWith(PREFIX)) throw new FormatException('That is not a TBD pairing code');
  const bytes = unbase32(cleaned.slice(PREFIX.length).replace(/[\s-]+/g, ''));
  if (bytes.length < 36 || bytes[0] !== 1) throw new FormatException('Pairing code is incomplete');
  const body = bytes.slice(0, 34);
  const crc = crc16(body);
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 255)) {
    throw new FormatException('Pairing code has a typo. Copy it again.');
  }
  const period = body[33];
  if (period < MIN_PERIOD || period > MAX_PERIOD) throw new FormatException('Invalid pairing code');
  return { secret: body.slice(1, 33), period };
}
