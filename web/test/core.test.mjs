import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBackup, newDeviceKey, openWithKey, restoreBackup, sealWithKey } from '../shared/crypto.js';
import { newVault, validateVault } from '../shared/model.js';
import { code, codeForCounter, secondsLeft, step, verify } from '../shared/otp.js';
import { decodePairing, encodePairing } from '../shared/pairing.js';
import { FormatException, UserError, encoder, fromB64, toB64 } from '../shared/util.js';
import { FAST_KDF } from './helpers.mjs';

const secret = Uint8Array.from({ length: 32 }, (_, i) => i);
const sample = () => ({
  ...newVault(toB64(secret), 7),
  entries: [
    {
      id: 'one',
      name: 'Example',
      site: 'example.com',
      username: 'friend',
      password: 'long unique password',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  revision: 1,
  lastBackupRevision: 0,
});

test('codes: RFC 6238 SHA-256 vector', async () => {
  const key = encoder.encode('12345678901234567890123456789012');
  assert.equal(await codeForCounter(key, Math.floor(59 / 30)), '46119246');
});

test('codes: interval maths at boundaries', () => {
  for (const period of [5, 7, 10]) {
    const start = period * 1000 * 12345;
    assert.equal(step(start, period), 12345);
    assert.equal(secondsLeft(start, period), period);
    assert.equal(secondsLeft(start + period * 1000 - 1, period), 1);
    assert.equal(step(start + period * 1000, period), 12346);
  }
});

test('codes: eight digits, change each interval, only 5 to 10 s', async () => {
  const t = Date.UTC(2026, 0, 1, 0, 0, 1);
  for (const period of [5, 7, 10]) {
    const a = await code(secret, t, period);
    assert.match(a, /^\d{8}$/);
    assert.notEqual(a, await code(secret, t + period * 1000, period));
  }
  await assert.rejects(code(secret, t, 30), RangeError);
});

test('verify: accepts any allowed interval, rejects malformed input and replays', async () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 3);
  for (const period of [5, 6, 7, 8, 9, 10]) {
    assert.equal((await verify(await code(secret, now, period), secret, now, 0)).ok, true, `period ${period}`);
  }
  const good = await code(secret, now, 10);
  for (const bad of ['', '1234567', '123456789', 'abcdefgh', `${good} `]) {
    assert.equal((await verify(bad, secret, now, 0)).ok, false, bad);
  }
  const first = await verify(good, secret, now, 0);
  assert.equal((await verify(good, secret, now, first.end)).reason, 'replay');
  const next = await code(secret, now + 10_000, 10);
  assert.equal((await verify(next, secret, now + 10_000, first.end)).ok, true);
});

test('pairing code: round trip, tolerance, typo detection', () => {
  const text = encodePairing(secret, 8);
  assert.match(text, /^TBD1(-[0-9A-Z]{1,8})+$/);
  const back = decodePairing(text);
  assert.deepEqual([...back.secret], [...secret]);
  assert.equal(back.period, 8);
  assert.equal(decodePairing(`  ${text.toLowerCase().replaceAll('-', ' ')}  `).period, 8);
  const chars = [...text];
  const i = chars.findIndex((c, n) => n > 8 && c !== '-');
  chars[i] = chars[i] === 'A' ? 'B' : 'A';
  assert.throws(() => decodePairing(chars.join('')), FormatException);
  assert.throws(() => decodePairing('hello'), FormatException);
  assert.throws(() => decodePairing(text.slice(0, 30)), FormatException);
});

test('records: round trip, wrong key, tampering', async () => {
  const key = await newDeviceKey();
  const record = await sealWithKey(key, 'T-1', { secret: 'value' });
  assert.ok(!JSON.stringify(record).includes('value'));
  assert.deepEqual(await openWithKey(key, record, 'T-1'), { secret: 'value' });
  await assert.rejects(openWithKey(await newDeviceKey(), record, 'T-1'), UserError);
  await assert.rejects(openWithKey(key, record, 'T-2'), FormatException);
  const flipped = fromB64(record.ct);
  flipped[0] ^= 1;
  await assert.rejects(openWithKey(key, { ...record, ct: toB64(flipped) }, 'T-1'), UserError);
  await assert.rejects(openWithKey(key, { ...record, nonce: 'AAAA' }, 'T-1'), FormatException);
  assert.notEqual((await sealWithKey(key, 'T-1', { a: 1 })).nonce, (await sealWithKey(key, 'T-1', { a: 1 })).nonce);
});

test('backup: round trip, unreadable without the password', async () => {
  const bytes = await createBackup(sample(), 'a long backup password', FAST_KDF);
  assert.ok(!new TextDecoder().decode(bytes).includes('long unique password'));
  const restored = await restoreBackup(bytes, 'a long backup password');
  assert.equal(restored.entries[0].password, 'long unique password');
  await assert.rejects(restoreBackup(bytes, 'incorrect password!'), UserError);
  await assert.rejects(createBackup(sample(), 'too short', FAST_KDF), UserError);
  const again = await createBackup(sample(), 'a long backup password', FAST_KDF);
  assert.notDeepEqual(bytes, again);
});

test('backup: every altered field, truncation and garbage are rejected', async () => {
  const pw = 'a long backup password';
  const bytes = await createBackup(sample(), pw, FAST_KDF);
  const doc = () => JSON.parse(new TextDecoder().decode(bytes));
  const encode = (d) => encoder.encode(JSON.stringify(d));
  for (const field of ['salt', 'nonce', 'ciphertext', 'mac']) {
    const d = doc();
    const raw = fromB64(d[field]);
    raw[raw.length - 1] ^= 1;
    d[field] = toB64(raw);
    await assert.rejects(restoreBackup(encode(d), pw), Error, field);
  }
  for (const field of ['format', 'kdf']) {
    const d = doc();
    d[field] = `${d[field]}x`;
    await assert.rejects(restoreBackup(encode(d), pw), FormatException, field);
  }
  const missing = doc();
  delete missing.mac;
  const inputs = [
    encode(missing),
    bytes.slice(0, bytes.length / 2),
    encoder.encode('not json'),
    encoder.encode('[]'),
    new Uint8Array(0),
    Uint8Array.from({ length: 300 }, (_, i) => i),
  ];
  for (const input of inputs) await assert.rejects(restoreBackup(input, pw), Error);
  await assert.rejects(restoreBackup(new Uint8Array(10 * 1024 * 1024 + 1), pw), FormatException);
  const heavy = doc();
  heavy.kdf = 'argon2id-4000000-3-1';
  await assert.rejects(restoreBackup(encode(heavy), pw), FormatException);
});

test('backup made by the earlier Flutter apps still opens (cross-implementation)', async () => {
  const path = new URL('../../packages/tbd_core/test/fixtures/backup-v1.fixture', import.meta.url);
  const bytes = new Uint8Array(await readFile(path));
  const restored = await restoreBackup(bytes, 'fixture backup password');
  assert.equal(restored.period, 7);
  assert.equal(restored.revision, 3);
  assert.equal(restored.entries[0].name, 'Fixture Account');
  assert.equal(restored.entries[0].password, 'fixture-password-é中');
  assert.deepEqual([...fromB64(restored.otpSecret)], Array.from({ length: 32 }, (_, i) => 255 - i));
  await assert.rejects(restoreBackup(bytes, 'wrong fixture password'), UserError);
});

test('model: rejects malformed vaults', () => {
  const bad = [
    null,
    {},
    { ...sample(), schema: 2 },
    { ...sample(), period: 4 },
    { ...sample(), period: 11 },
    { ...sample(), otpSecret: 'AAAA' },
    { ...sample(), entries: [{ id: 'x' }] },
    { ...sample(), revision: 1.5 },
  ];
  for (const value of bad) assert.throws(() => validateVault(value), FormatException);
  assert.equal(validateVault(sample()).lastAcceptedEnd, 0);
});
