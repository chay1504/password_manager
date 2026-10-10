import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodesController } from '../codes/controller.js';
import { VaultController } from '../vault/controller.js';
import { code } from '../shared/otp.js';
import { decodePairing } from '../shared/pairing.js';
import { memoryStore } from '../shared/store.js';
import { UserError, toB64 } from '../shared/util.js';
import { FAST_KDF, FakeFace, fakeClock } from './helpers.mjs';

const BACKUP_PASS = 'a long backup password';

function newApps(clock, stores = { vault: memoryStore(), codes: memoryStore() }, faces = { vault: new FakeFace(), codes: new FakeFace() }) {
  return {
    stores,
    faces,
    vault: new VaultController(stores.vault, faces.vault, { clock, backupKdf: FAST_KDF }),
    codes: new CodesController(stores.codes, faces.codes, { clock }),
  };
}

async function setup() {
  const clock = fakeClock();
  const ctx = { clock, ...newApps(clock) };
  await ctx.vault.init();
  await ctx.codes.init();
  return ctx;
}

async function pairedAndInCodeStep() {
  const ctx = await setup();
  assert.equal(ctx.vault.phase, 'setup');
  assert.equal(await ctx.vault.create(), true);
  assert.equal(ctx.vault.phase, 'code');
  assert.equal(await ctx.codes.add(ctx.vault.pairingCode()), true);
  assert.equal(ctx.codes.phase, 'show');
  return ctx;
}

test('full flow: face lock, key added, code opens the vault', async () => {
  const { vault, codes } = await pairedAndInCodeStep();
  const { code: shown } = await codes.current();
  assert.match(shown, /^\d{8}$/);
  assert.equal(await vault.verifyCode(shown), true);
  assert.equal(vault.phase, 'open');
});

test('no typed passphrase exists anywhere in the flow', async () => {
  const { vault, codes, stores } = await pairedAndInCodeStep();
  assert.equal(vault.create.length, 0);
  assert.equal(codes.unlock.length, 0);
  const record = await stores.vault.get('vault');
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'format', 'nonce']);
});

test('declined face lock changes nothing', async () => {
  const ctx = await setup();
  ctx.faces.vault.refuse = true;
  await assert.rejects(ctx.vault.create(), UserError);
  assert.equal(ctx.vault.phase, 'setup');
  assert.equal(await ctx.stores.vault.get('vault'), undefined);
});

test('unlock needs face lock; refusing it keeps the vault locked', async () => {
  const ctx = await pairedAndInCodeStep();
  ctx.vault.lock();
  ctx.faces.vault.refuse = true;
  assert.equal(await ctx.vault.unlock(), false);
  assert.match(ctx.vault.message, /Face unlock/);
  assert.equal(ctx.vault.phase, 'locked');
  assert.equal(ctx.vault.data, null);
  ctx.faces.vault.refuse = false;
  assert.equal(await ctx.vault.unlock(), true);
  assert.equal(ctx.vault.phase, 'code');
});

test('a different face lock key cannot open the stored vault', async () => {
  const ctx = await pairedAndInCodeStep();
  ctx.vault.lock();
  await ctx.faces.vault.enroll(); // replaces the key, as a deleted passkey would
  assert.equal(await ctx.vault.unlock(), false);
  assert.match(ctx.vault.message, /Could not open|Wrong/);
  assert.equal(ctx.vault.phase, 'locked');
});

test('wrong, short and expired codes are refused with a neutral message', async () => {
  const { vault, codes, clock } = await pairedAndInCodeStep();
  const { code: old } = await codes.current();
  clock.advance(10_000);
  assert.equal(await vault.verifyCode(old), false);
  assert.match(vault.message, /not accepted/);
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
  assert.equal(await ctx.vault.unlock(), true);
  assert.equal(await ctx.vault.verifyCode(used), false);

  const restarted = newApps(ctx.clock, ctx.stores, ctx.faces).vault;
  await restarted.init();
  assert.equal(restarted.phase, 'locked');
  await restarted.unlock();
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
  const stored = JSON.stringify(await ctx.stores.vault.get('vault'));
  assert.ok(!stored.includes('very-secret-password'));
  assert.ok(!stored.includes('Bank'));
  const secretB64 = toB64(decodePairing(ctx.vault.pairingCode()).secret);
  ctx.vault.lock();
  assert.equal(ctx.vault.data, null);
  assert.throws(() => ctx.vault.pairingCode(), UserError);
  assert.ok(!JSON.stringify(await ctx.stores.codes.get('seed')).includes(secretB64));
  assert.ok(!stored.includes(secretB64));
});

test('restore on a fresh device: entries come back, key must be added again', async () => {
  const old = await pairedAndInCodeStep();
  await old.vault.verifyCode((await old.codes.current()).code);
  const first = await old.vault.exportBackup(BACKUP_PASS);
  await old.vault.markBackedUp(first.revision);
  await old.vault.saveEntry({ name: 'Mail', username: 'me', password: 'pw-1' });
  const { bytes, revision } = await old.vault.exportBackup(BACKUP_PASS);
  await old.vault.markBackedUp(revision);

  const fresh = await setup();
  await assert.rejects(fresh.vault.importBackup(bytes, 'wrong backup password'), UserError);
  assert.equal(fresh.vault.phase, 'setup');
  assert.equal(await fresh.vault.importBackup(bytes, BACKUP_PASS), true);
  assert.equal(fresh.vault.phase, 'code');
  assert.equal(await fresh.codes.add(fresh.vault.pairingCode()), true);
  assert.equal(await fresh.vault.verifyCode((await fresh.codes.current()).code), true);
  assert.equal(fresh.vault.data.entries[0].password, 'pw-1');
  assert.equal(fresh.vault.backupOutdated, false);
});

test('a failed face prompt during restore leaves the existing vault alone', async () => {
  const old = await pairedAndInCodeStep();
  await old.vault.verifyCode((await old.codes.current()).code);
  const { bytes, revision } = await old.vault.exportBackup(BACKUP_PASS);
  await old.vault.markBackedUp(revision);
  old.vault.lock();
  const before = JSON.stringify(await old.stores.vault.get('vault'));
  old.faces.vault.refuse = true;
  await assert.rejects(old.vault.importBackup(bytes, BACKUP_PASS), UserError);
  assert.equal(JSON.stringify(await old.stores.vault.get('vault')), before);
});

test('Codes: needs face lock to show; bad key text is refused', async () => {
  const ctx = await pairedAndInCodeStep();
  ctx.codes.lock();
  assert.equal(await ctx.codes.current(), null);
  ctx.faces.codes.refuse = true;
  assert.equal(await ctx.codes.unlock(), false);
  assert.equal(ctx.codes.phase, 'locked');
  ctx.faces.codes.refuse = false;
  assert.equal(await ctx.codes.unlock(), true);
  assert.equal(ctx.codes.phase, 'show');

  const fresh = await setup();
  await assert.rejects(fresh.codes.add('not a code'), UserError);
  assert.equal(fresh.codes.phase, 'setup');
});

test('records from the earlier passphrase version are reported as legacy, not opened', async () => {
  const clock = fakeClock();
  const stores = { vault: memoryStore(), codes: memoryStore() };
  await stores.vault.set('vault', { format: 'TBD-WEB-VAULT-v1', kdf: {}, salt: '', nonce: '', ct: '' });
  await stores.codes.set('seed', { format: 'TBD-WEB-CODES-v1' });
  const apps = newApps(clock, stores);
  await apps.vault.init();
  await apps.codes.init();
  assert.equal(apps.vault.phase, 'legacy');
  assert.equal(apps.codes.phase, 'legacy');
  await apps.vault.eraseDevice();
  assert.equal(apps.vault.phase, 'setup');
});

test('erasing the device returns to setup and removes stored data', async () => {
  const ctx = await pairedAndInCodeStep();
  await ctx.vault.eraseDevice();
  assert.equal(ctx.vault.phase, 'setup');
  assert.equal(await ctx.stores.vault.get('vault'), undefined);
});

test('the Codes display matches an independent code computation', async () => {
  const { vault, codes, clock } = await pairedAndInCodeStep();
  const { secret } = decodePairing(vault.pairingCode());
  assert.equal((await codes.current()).code, await code(secret, clock(), 10));
});
