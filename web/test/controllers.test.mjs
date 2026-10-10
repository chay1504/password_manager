import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodesController } from '../codes/controller.js';
import { VaultController } from '../vault/controller.js';
import { code } from '../shared/otp.js';
import { decodePairing } from '../shared/pairing.js';
import { memoryStore } from '../shared/store.js';
import { UserError, toB64 } from '../shared/util.js';
import { FAST_KDF, fakeClock } from './helpers.mjs';

const PASS = 'a long vault passphrase';
const BACKUP_PASS = 'a long backup password';

async function setup() {
  const clock = fakeClock();
  const vaultStore = memoryStore();
  const codesStore = memoryStore();
  const options = { clock, kdf: FAST_KDF, backupKdf: FAST_KDF };
  const make = () => ({
    vault: new VaultController(vaultStore, options),
    codes: new CodesController(codesStore, { clock, kdf: FAST_KDF }),
  });
  const apps = make();
  await apps.vault.init();
  await apps.codes.init();
  return { clock, vaultStore, codesStore, make, ...apps };
}

async function pairedAndInCodeStep() {
  const ctx = await setup();
  assert.equal(ctx.vault.phase, 'setup');
  await ctx.vault.create(PASS, PASS);
  assert.equal(ctx.vault.phase, 'code');
  assert.equal(await ctx.codes.pair(ctx.vault.pairingCode(), 'pin123', 'pin123'), true);
  assert.equal(ctx.codes.phase, 'show');
  return ctx;
}

test('full flow: create, pair, code from Codes opens the vault', async () => {
  const { vault, codes } = await pairedAndInCodeStep();
  const { code: shown } = await codes.current();
  assert.match(shown, /^\d{8}$/);
  assert.equal(await vault.verifyCode(shown), true);
  assert.equal(vault.phase, 'open');
});

test('wrong, short and expired codes are refused with a clear message', async () => {
  const { vault, codes, clock } = await pairedAndInCodeStep();
  const { code: old } = await codes.current();
  clock.advance(10_000);
  assert.equal(await vault.verifyCode(old), false);
  assert.match(vault.message, /did not match or already expired/);
  assert.equal(await vault.verifyCode('123'), false);
  assert.match(vault.message, /all 8 digits/);
  assert.equal(vault.phase, 'code');
  assert.equal(await vault.verifyCode((await codes.current()).code), true);
});

test('five wrong codes lock entry, even for the right code, until the wait ends', async () => {
  const { vault, codes, clock } = await pairedAndInCodeStep();
  for (let i = 0; i < 5; i++) await vault.verifyCode('00000000');
  assert.match(vault.message, /Wait 30 seconds/);
  assert.equal(await vault.verifyCode((await codes.current()).code), false);
  assert.match(vault.message, /Wait/);
  clock.advance(31_000);
  assert.equal(await vault.verifyCode((await codes.current()).code), true);
});

test('an accepted code cannot be replayed, even after locking or restarting', async () => {
  const ctx = await pairedAndInCodeStep();
  const { code: used } = await ctx.codes.current();
  assert.equal(await ctx.vault.verifyCode(used), true);
  ctx.vault.lock();
  assert.equal(await ctx.vault.unlock(PASS), true);
  assert.equal(await ctx.vault.verifyCode(used), false);

  const restarted = ctx.make().vault;
  await restarted.init();
  assert.equal(restarted.phase, 'locked');
  await restarted.unlock(PASS);
  assert.equal(await restarted.verifyCode(used), false);

  ctx.clock.advance(10_000);
  assert.equal(await restarted.verifyCode((await ctx.codes.current()).code), true);
});

test('changing the interval in Codes works without touching Vault', async () => {
  const { vault, codes } = await pairedAndInCodeStep();
  for (const period of [5, 7]) {
    await codes.setPeriod(period);
    assert.equal(codes.period, period);
  }
  assert.equal(await vault.verifyCode((await codes.current()).code), true);
});

test('wrong vault passphrase is counted and blocks after five tries', async () => {
  const ctx = await pairedAndInCodeStep();
  ctx.vault.lock();
  for (let i = 0; i < 4; i++) {
    assert.equal(await ctx.vault.unlock('definitely wrong one'), false);
    assert.equal(ctx.vault.message, 'Wrong passphrase.');
  }
  await ctx.vault.unlock('definitely wrong one');
  assert.match(ctx.vault.message, /Wait 30 seconds/);
  assert.equal(await ctx.vault.unlock(PASS), false);
  ctx.clock.advance(31_000);
  assert.equal(await ctx.vault.unlock(PASS), true);
});

test('weak or mismatched passphrases are refused at setup', async () => {
  const { vault } = await setup();
  await assert.rejects(vault.create('short', 'short'), UserError);
  await assert.rejects(vault.create(PASS, `${PASS}x`), UserError);
  assert.equal(vault.phase, 'setup');
});

test('entries need a first backup, then can be added, edited, deleted', async () => {
  const { vault, codes } = await pairedAndInCodeStep();
  await vault.verifyCode((await codes.current()).code);
  const entry = { name: 'GitHub', site: 'github.com', username: 'deepak', password: 's3cret!' };
  await assert.rejects(vault.saveEntry(entry), /first encrypted backup/);

  assert.equal(vault.backupOutdated, true);
  const { bytes, revision } = await vault.exportBackup(BACKUP_PASS);
  await vault.markBackedUp(revision);
  assert.equal(vault.backupOutdated, false);

  const id = await vault.saveEntry(entry);
  assert.equal(vault.backupOutdated, true);
  assert.equal(vault.data.entries.length, 1);
  await vault.saveEntry({ ...entry, id, password: 'changed' });
  assert.equal(vault.data.entries[0].password, 'changed');
  assert.equal(vault.data.entries[0].createdAt <= vault.data.entries[0].updatedAt, true);
  await assert.rejects(vault.saveEntry({ name: ' ', password: 'x' }), UserError);
  await vault.deleteEntry(id);
  assert.equal(vault.data.entries.length, 0);
  assert.equal(await vault.testBackup(bytes, BACKUP_PASS), 0);
});

test('data is encrypted at rest and hidden while locked', async () => {
  const ctx = await pairedAndInCodeStep();
  await ctx.vault.verifyCode((await ctx.codes.current()).code);
  const { revision } = await ctx.vault.exportBackup(BACKUP_PASS);
  await ctx.vault.markBackedUp(revision);
  await ctx.vault.saveEntry({ name: 'Bank', password: 'very-secret-password' });
  const stored = JSON.stringify(await ctx.vaultStore.get('vault'));
  assert.ok(!stored.includes('very-secret-password'));
  assert.ok(!stored.includes('Bank'));
  const secretB64 = toB64(decodePairing(ctx.vault.pairingCode()).secret);
  ctx.vault.lock();
  assert.equal(ctx.vault.data, null);
  assert.throws(() => ctx.vault.pairingCode(), UserError);
  const seed = JSON.stringify(await ctx.codesStore.get('seed'));
  assert.ok(!seed.includes(secretB64));
  assert.ok(!stored.includes(secretB64));
});

test('restore on a fresh device: entries come back, Codes must pair again', async () => {
  const old = await pairedAndInCodeStep();
  await old.vault.verifyCode((await old.codes.current()).code);
  const first = await old.vault.exportBackup(BACKUP_PASS);
  await old.vault.markBackedUp(first.revision);
  await old.vault.saveEntry({ name: 'Mail', username: 'me', password: 'pw-1' });
  const { bytes, revision } = await old.vault.exportBackup(BACKUP_PASS);
  await old.vault.markBackedUp(revision);

  const fresh = await setup();
  await assert.rejects(fresh.vault.importBackup(bytes, 'wrong backup password', PASS, PASS), UserError);
  assert.equal(fresh.vault.phase, 'setup');
  assert.equal(await fresh.vault.importBackup(bytes, BACKUP_PASS, 'new device passphrase', 'new device passphrase'), true);
  assert.equal(fresh.vault.phase, 'code');
  assert.equal(await fresh.codes.pair(fresh.vault.pairingCode(), 'pin123', 'pin123'), true);
  assert.equal(await fresh.vault.verifyCode((await fresh.codes.current()).code), true);
  assert.equal(fresh.vault.data.entries[0].password, 'pw-1');
  assert.equal(fresh.vault.backupOutdated, false);
});

test('Codes: wrong app passphrase is limited; bad pairing text is refused', async () => {
  const ctx = await pairedAndInCodeStep();
  ctx.codes.lock();
  assert.equal(await ctx.codes.current(), null);
  for (let i = 0; i < 5; i++) await ctx.codes.unlock('nope-nope');
  assert.match(ctx.codes.message, /Wait 30 seconds/);
  ctx.clock.advance(31_000);
  assert.equal(await ctx.codes.unlock('pin123'), true);

  const fresh = await setup();
  await assert.rejects(fresh.codes.pair('not a code', 'pin123', 'pin123'), UserError);
  await assert.rejects(fresh.codes.pair(ctx.vault.pairingCode(), 'abc', 'abc'), UserError);
  assert.equal(fresh.codes.phase, 'setup');
});

test('erasing the device returns to setup and removes stored data', async () => {
  const ctx = await pairedAndInCodeStep();
  await ctx.vault.eraseDevice();
  assert.equal(ctx.vault.phase, 'setup');
  assert.equal(await ctx.vaultStore.get('vault'), undefined);
});

test('the Codes display matches an independent code computation', async () => {
  const { vault, codes, clock } = await pairedAndInCodeStep();
  const { secret } = decodePairing(vault.pairingCode());
  assert.equal((await codes.current()).code, await code(secret, clock(), 10));
});
