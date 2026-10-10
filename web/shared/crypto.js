// Passphrase-protected records (local storage) and encrypted backup files.
// Both use Argon2id for the key and AES-256-GCM for confidentiality + integrity.
import { argon2id } from './vendor/argon2.js';
import { validateVault } from './model.js';
import {
  FormatException,
  UserError,
  charCount,
  decoder,
  encoder,
  fromB64,
  randomBytes,
  toB64,
} from './util.js';

export const BACKUP_KDF = { m: 65536, t: 3, p: 1 };
const KDF_LIMITS = { mMin: 8192, mMax: 262144, tMin: 1, tMax: 10 };

export const BACKUP_FORMAT = 'TBD-BACKUP-v1';
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MIN_BACKUP_PASSWORD = 12;

function checkKdf({ m, t, p }) {
  if (
    !Number.isInteger(m) || m < KDF_LIMITS.mMin || m > KDF_LIMITS.mMax ||
    !Number.isInteger(t) || t < KDF_LIMITS.tMin || t > KDF_LIMITS.tMax ||
    p !== 1
  ) {
    throw new FormatException('Unsupported key settings');
  }
}

async function deriveKey(secretText, salt, kdf) {
  checkKdf(kdf);
  const raw = await argon2id({
    password: secretText.normalize('NFKC'),
    salt,
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return key;
}

async function encrypt(key, plain, aad) {
  const nonce = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plain),
  );
  return { nonce, cipherText: sealed.slice(0, -16), mac: sealed.slice(-16) };
}

async function decrypt(key, nonce, cipherText, mac, aad) {
  const sealed = new Uint8Array(cipherText.length + mac.length);
  sealed.set(cipherText);
  sealed.set(mac, cipherText.length);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, sealed),
    );
  } catch {
    throw new UserError('Wrong password or key, or the data was changed');
  }
}

/* ------- Local records: sealed with a key that face unlock provides ------- */

/** A random AES key the browser will never hand back to page code. */
export function newDeviceKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealWithKey(key, format, object) {
  const { nonce, cipherText, mac } = await encrypt(
    key,
    encoder.encode(JSON.stringify(object)),
    encoder.encode(format),
  );
  const body = new Uint8Array(cipherText.length + mac.length);
  body.set(cipherText);
  body.set(mac, cipherText.length);
  return { format, nonce: toB64(nonce), ct: toB64(body) };
}

/** Throws FormatException for an unknown record, UserError if the key does not fit. */
export async function openWithKey(key, record, format) {
  if (record === null || typeof record !== 'object' || record.format !== format) {
    throw new FormatException('Unsupported record');
  }
  const nonce = fromB64(record.nonce);
  const body = fromB64(record.ct);
  if (nonce.length !== 12 || body.length < 16) throw new FormatException('Invalid record');
  const plain = await decrypt(key, nonce, body.slice(0, -16), body.slice(-16), encoder.encode(format));
  return JSON.parse(decoder.decode(plain));
}

/* ---------------------------- Backup files ---------------------------- */

const kdfName = ({ m, t, p }) => `argon2id-${m}-${t}-${p}`;

function parseKdfName(name) {
  const match = /^argon2id-(\d{1,7})-(\d{1,3})-(\d{1,2})$/.exec(String(name));
  if (!match) throw new FormatException('Unsupported backup');
  return { m: Number(match[1]), t: Number(match[2]), p: Number(match[3]) };
}

export function checkBackupPassword(password) {
  if (charCount(password) < MIN_BACKUP_PASSWORD) {
    throw new UserError(`Backup password must be at least ${MIN_BACKUP_PASSWORD} characters`);
  }
}

export async function createBackup(vault, password, kdf = BACKUP_KDF) {
  checkBackupPassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, kdf);
  const { nonce, cipherText, mac } = await encrypt(
    key,
    encoder.encode(JSON.stringify(vault)),
    encoder.encode(BACKUP_FORMAT),
  );
  return encoder.encode(
    JSON.stringify({
      format: BACKUP_FORMAT,
      kdf: kdfName(kdf),
      salt: toB64(salt),
      nonce: toB64(nonce),
      ciphertext: toB64(cipherText),
      mac: toB64(mac),
    }),
  );
}

export async function restoreBackup(bytes, password) {
  if (bytes.length > MAX_BACKUP_BYTES) throw new FormatException('Backup file is too large');
  let outer;
  try {
    outer = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new FormatException('This is not a TBD backup file');
  }
  if (outer === null || typeof outer !== 'object' || outer.format !== BACKUP_FORMAT) {
    throw new FormatException('Unsupported backup');
  }
  const kdf = parseKdfName(outer.kdf);
  const salt = fromB64(outer.salt);
  const nonce = fromB64(outer.nonce);
  const mac = fromB64(outer.mac);
  const cipherText = fromB64(outer.ciphertext);
  if (salt.length !== 16 || nonce.length !== 12 || mac.length !== 16) {
    throw new FormatException('Invalid backup');
  }
  const key = await deriveKey(password, salt, kdf);
  const plain = await decrypt(key, nonce, cipherText, mac, encoder.encode(BACKUP_FORMAT));
  let json;
  try {
    json = JSON.parse(decoder.decode(plain));
  } catch {
    throw new FormatException('Backup contents are damaged');
  }
  return validateVault(json);
}
