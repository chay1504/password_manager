// TBD Vault logic, independent of the screen so it can be tested.
// Phases: loading -> setup | locked | legacy -> code -> open
// The vault is unlocked by face lock, then by a current 8-digit code.
import {
  BACKUP_KDF, checkBackupPassword, createBackup, openWithKey, restoreBackup, sealWithKey,
} from '../shared/crypto.js';
import { AttemptLimiter } from '../shared/limiter.js';
import { backupOutdated, newVault, validateVault } from '../shared/model.js';
import { DEFAULT_PERIOD, verify } from '../shared/otp.js';
import { encodePairing } from '../shared/pairing.js';
import { UserError, fromB64, randomBytes, toB64 } from '../shared/util.js';

export const FORMAT = 'TBD-WEB-VAULT-v2';
const RECORD_KEY = 'vault';

/**
 * `face` provides the key: enroll() creates face lock and returns a key,
 * unlock() asks for face or fingerprint and returns it, mode() reports strength.
 */
export class VaultController extends EventTarget {
  #store;
  #clock;
  #backupKdf;
  #face;
  #key = null;
  #vault = null;
  #codeTries;

  phase = 'loading';
  busy = false;
  message = '';

  constructor(store, face, { clock = Date.now, backupKdf = BACKUP_KDF } = {}) {
    super();
    this.#store = store;
    this.#face = face;
    this.#clock = clock;
    this.#backupKdf = backupKdf;
    this.#codeTries = new AttemptLimiter(store, 'code', clock);
  }

  /** Decrypted data, only while the vault is open. */
  get data() {
    return this.phase === 'open' ? this.#vault : null;
  }

  get backupOutdated() {
    return this.#vault ? backupOutdated(this.#vault) : true;
  }

  /** 'strong' or 'basic' (see shared/face.js). */
  faceStrength() {
    return this.#face.mode();
  }

  #set(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.dispatchEvent(new Event('change'));
  }

  async #guard(work) {
    if (this.busy) return false;
    this.busy = true;
    this.message = '';
    this.dispatchEvent(new Event('change'));
    try {
      return await work();
    } finally {
      this.busy = false;
      this.dispatchEvent(new Event('change'));
    }
  }

  #fail(message) {
    this.message = message;
    return false;
  }

  async init() {
    try {
      const record = await this.#store.get(RECORD_KEY);
      this.#set(!record ? 'setup' : record.format === FORMAT ? 'locked' : 'legacy');
    } catch {
      this.#set('error', 'This browser cannot store data privately. Try another browser.');
    }
  }

  async #save() {
    await this.#store.set(RECORD_KEY, await sealWithKey(this.#key, FORMAT, this.#vault));
  }

  async #update(changes) {
    this.#vault = { ...this.#vault, ...changes, revision: this.#vault.revision + 1 };
    await this.#save();
  }

  /** The key text for generating codes. Only while the vault is unlocked. */
  pairingCode() {
    if (!this.#vault) throw new UserError('Unlock the vault first');
    return encodePairing(fromB64(this.#vault.otpSecret), this.#vault.period);
  }

  /** Sets up face lock on this device and creates an empty vault. */
  async create() {
    if (this.phase !== 'setup') return false;
    return this.#guard(async () => {
      const key = await this.#face.enroll();
      this.#key = key;
      this.#vault = newVault(toB64(randomBytes(32)), DEFAULT_PERIOD);
      await this.#save();
      await this.#codeTries.reset();
      this.#set('code', '');
      return true;
    });
  }

  async unlock() {
    if (this.phase !== 'locked') return false;
    return this.#guard(async () => {
      try {
        const key = await this.#face.unlock();
        const object = await openWithKey(key, await this.#store.get(RECORD_KEY), FORMAT);
        this.#vault = validateVault(object);
        this.#key = key;
      } catch (error) {
        return this.#fail(
          error instanceof UserError ? error.message : 'Could not open the vault on this device. Restore a backup.',
        );
      }
      this.#set('code', '');
      return true;
    });
  }

  async verifyCode(input) {
    if (this.phase !== 'code') return false;
    return this.#guard(async () => {
      const wait = await this.#codeTries.waitSeconds();
      if (wait > 0) return this.#fail(`Too many tries. Wait ${wait} seconds.`);
      const result = await verify(
        String(input).trim(), fromB64(this.#vault.otpSecret), this.#clock(), this.#vault.lastAcceptedEnd,
      );
      if (!result.ok) {
        const blocked = await this.#codeTries.fail();
        return this.#fail(
          blocked
            ? `Too many tries. Wait ${blocked} seconds.`
            : result.reason === 'format'
              ? 'Enter all 8 digits.'
              : 'That code was not accepted. Enter a current code.',
        );
      }
      await this.#codeTries.reset();
      this.#vault = { ...this.#vault, lastAcceptedEnd: result.end };
      await this.#save();
      this.#set('open', '');
      return true;
    });
  }

  lock() {
    if (this.phase !== 'open' && this.phase !== 'code') return;
    this.#key = null;
    this.#vault = null;
    this.#set('locked', '');
  }

  async saveEntry({ id, name, site = '', username = '', password }) {
    this.#requireOpen();
    if (this.#vault.lastBackupRevision < 0) {
      throw new UserError('Export your first encrypted backup before adding passwords');
    }
    if (name.trim() === '' || password === '') {
      throw new UserError('Account name and password are required');
    }
    const now = new Date(this.#clock()).toISOString();
    const existing = id ? this.#vault.entries.find((e) => e.id === id) : undefined;
    const entry = {
      id: existing ? existing.id : toB64(randomBytes(12)).replace(/[+/=]/g, 'x'),
      name: name.trim(),
      site: site.trim(),
      username: username.trim(),
      password,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const entries = [...this.#vault.entries.filter((e) => e.id !== entry.id), entry];
    await this.#update({ entries });
    this.dispatchEvent(new Event('change'));
    return entry.id;
  }

  async deleteEntry(id) {
    this.#requireOpen();
    await this.#update({ entries: this.#vault.entries.filter((e) => e.id !== id) });
    this.dispatchEvent(new Event('change'));
  }

  #requireOpen() {
    if (this.phase !== 'open' || !this.#vault) throw new UserError('Unlock the vault first');
  }

  /** Builds an encrypted backup. Call markBackedUp() once the file is saved. */
  async exportBackup(password) {
    this.#requireOpen();
    checkBackupPassword(password);
    const snapshot = { ...this.#vault, lastBackupRevision: this.#vault.revision };
    const bytes = await createBackup(snapshot, password, this.#backupKdf);
    const check = await restoreBackup(bytes, password);
    if (check.entries.length !== snapshot.entries.length || check.otpSecret !== snapshot.otpSecret) {
      throw new UserError('Backup verification failed. Nothing was saved.');
    }
    return { bytes, revision: snapshot.revision };
  }

  async markBackedUp(revision) {
    this.#requireOpen();
    if (revision > this.#vault.lastBackupRevision) {
      this.#vault = { ...this.#vault, lastBackupRevision: revision };
      await this.#save();
      this.dispatchEvent(new Event('change'));
    }
  }

  /** Checks a backup file without touching the vault. Returns the entry count. */
  async testBackup(bytes, password) {
    return (await restoreBackup(bytes, password)).entries.length;
  }

  /** Replaces this device's vault with a backup and sets up face lock again. */
  async importBackup(bytes, backupPassword) {
    if (this.phase !== 'setup' && this.phase !== 'locked' && this.phase !== 'legacy') {
      throw new UserError('Lock the vault before restoring a backup');
    }
    return this.#guard(async () => {
      const restored = await restoreBackup(bytes, backupPassword);
      const key = await this.#face.enroll();
      this.#key = key;
      this.#vault = { ...restored, lastBackupRevision: restored.revision, lastAcceptedStep: -1, lastAcceptedEnd: 0 };
      await this.#save();
      await this.#codeTries.reset();
      this.#set('code', '');
      return true;
    });
  }

  /** Permanently removes the vault and face lock from this device. */
  async eraseDevice() {
    await this.#store.clear();
    this.#key = null;
    this.#vault = null;
    this.#set('setup', '');
  }
}
