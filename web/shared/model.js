// Vault data. Schema 1 is the same JSON the earlier Flutter apps stored, so
// encrypted backups move between the two. `lastAcceptedEnd` is an extra field
// that older readers ignore.
import { fromB64, FormatException } from './util.js';
import { DEFAULT_PERIOD, MAX_PERIOD, MIN_PERIOD } from './otp.js';

const MAX_ENTRIES = 5000;
const MAX_TEXT = 10000;

export function newVault(secretB64, period = DEFAULT_PERIOD) {
  return {
    schema: 1,
    entries: [],
    otpSecret: secretB64,
    period,
    revision: 0,
    lastBackupRevision: -1,
    lastAcceptedStep: -1,
    lastAcceptedEnd: 0,
  };
}

function text(value, label, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    throw new FormatException(`Invalid ${label}`);
  }
  if (required && value.trim() === '') throw new FormatException(`Invalid ${label}`);
  return value;
}

function isoDate(value, label) {
  const ms = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(ms)) throw new FormatException(`Invalid ${label}`);
  return new Date(ms).toISOString();
}

function wholeNumber(value, label) {
  if (!Number.isSafeInteger(value)) throw new FormatException(`Invalid ${label}`);
  return value;
}

export function validateEntry(json) {
  if (json === null || typeof json !== 'object') throw new FormatException('Invalid entry');
  return {
    id: text(json.id, 'entry id', { required: true }),
    name: text(json.name, 'account name', { required: true }),
    site: text(json.site ?? '', 'website'),
    username: text(json.username ?? '', 'username'),
    password: text(json.password, 'password', { required: true }),
    createdAt: isoDate(json.createdAt, 'created date'),
    updatedAt: isoDate(json.updatedAt, 'updated date'),
  };
}

/** Throws FormatException for anything that is not a well-formed vault. */
export function validateVault(json) {
  if (json === null || typeof json !== 'object' || json.schema !== 1) {
    throw new FormatException('Unsupported vault version');
  }
  const period = wholeNumber(json.period, 'code interval');
  if (period < MIN_PERIOD || period > MAX_PERIOD) throw new FormatException('Invalid code interval');
  if (typeof json.otpSecret !== 'string' || fromB64(json.otpSecret).length !== 32) {
    throw new FormatException('Invalid code secret');
  }
  if (!Array.isArray(json.entries) || json.entries.length > MAX_ENTRIES) {
    throw new FormatException('Invalid entries');
  }
  return {
    schema: 1,
    entries: json.entries.map(validateEntry),
    otpSecret: json.otpSecret,
    period,
    revision: wholeNumber(json.revision, 'revision'),
    lastBackupRevision: wholeNumber(json.lastBackupRevision, 'backup revision'),
    lastAcceptedStep: wholeNumber(json.lastAcceptedStep, 'accepted step'),
    lastAcceptedEnd:
      json.lastAcceptedEnd === undefined ? 0 : wholeNumber(json.lastAcceptedEnd, 'accepted time'),
  };
}

export const backupOutdated = (vault) => vault.revision > vault.lastBackupRevision;
