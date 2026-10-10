// TBD Vault logic, independent of the screen so it can be tested.
// Phases: loading -> setup | locked -> code -> open   (same flow as the native apps)
import {
  BACKUP_KDF, LOCAL_KDF, checkBackupPassword, createBackup, newSession, open, restoreBackup, seal,
} from '../shared/crypto.js';
import { AttemptLimiter } from '../shared/limiter.js';
import { backupOutdated, newVault, validateVault } from '../shared/model.js';
import { DEFAULT_PERIOD, MAX_PERIOD, MIN_PERIOD, verify } from '../shared/otp.js';
import { encodePairing } from '../shared/pairing.js';
import { UserError, charCount, fromB64, randomBytes, toB64 } from '../shared/util.js';

export const FORMAT = 'TBD-WEB-VAULT-v1';
export const MIN_PASSPHRASE = 12;
const RECORD_KEY = 'vault';

export class VaultController extends EventTarget {
  #store;
  #clock;
  #kdf;
  #backupKdf;
  #session = null;
  #vault = null;
  #pass;
  #codeTries;

  phase = 'loading';
  busy = false;
  message = '';

  constructor(store, { clock = Date.now, kdf = LOCAL_KDF, backupKdf = BACKUP_KDF } = {}) {
    super();
    this.#store = store;
    this.#clock = clock;
    this.#kdf = kdf;
    this.#backupKdf = backupKdf;
    this.#pass = new AttemptLimiter(store, 'passphrase', clock);
    this.#codeTries = new AttemptLimiter(store, 'code', clock);
  }

  /** Decrypted data, only while the vault is open. */
  get data() {
    return this.phase === 'open' ? this.#vault : null;
  }

  get backupOutdated() {
    return this.#vault ? backupOutdated(this.#vault) : true;
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

  async init() {
    try {
      this.#set((await this.#store.get(RECORD_KEY)) ? 'locked' : 'setup');
    } catch {
      this.#set('error', 'This browser cannot store data privately. Try another browser.');
    }
  }

  async #save() {
    const record = await seal(this.#session, FORMAT, this.#vault);
    await this.#store.set(RECORD_KEY, record);
  }

  async #update(changes) {
    this.#vault = { ...this.#vault, ...changes, revision: this.#vault.revision + 1 };
    await this.#save();
  }

  /** The text to paste into TBD Codes. Only while a session is unlocked. */
  pairingCode() {
    if (!this.#vault) throw new UserError('Unlock the vault first');
    return encodePairing(fromB64(this.#vault.otpSecret), this.#vault.period);
  }

  async create(passphrase, confirmation) {
    if (this.phase !== 'setup') return false;
    checkPassphrase(passphrase, confirmation);
    return this.#guard(async () => {
      const vault = newVault(toB64(randomBytes(32)), DEFAULT_PERIOD);
      this.#session = await newSession(passphrase, this.#kdf);
      this.#vault = vault;
      await this.#save();
      await this.#pass.reset();
      await this.#codeTries.reset();
      this.#set('code', 'Vault created. Open TBD Codes, paste the pairing code, then enter the code it shows.');
      return true;
    });
  }

  async unlock(passphrase) {
    if (this.phase !== 'locked') return false;
    return this.#guard(async () => {
      const wait = await this.#pass.waitSeconds();
      if (wait > 0) return this.#fail(`Too many tries. Wait ${wait} seconds.`);
      try {
        const record = await this.#store.get(RECORD_KEY);
        const { session, object } = await open(record, FORMAT, passphrase);
        this.#session = session;
        this.#vault = validateVault(object);
      } catch (error) {
        if (error instanceof UserError) {
          const blocked = await this.#pass.fail();
          return this.#fail(blocked ? `Too many tries. Wait ${blocked} seconds.` : 'Wrong passphrase.');
        }
        return this.#fail('Could not open the vault on this device. Restore a backup.');
      }
      await this.#pass.reset();
      this.#set('code', '');
      return true;
    });
  }

  #fail(message) {
    this.message = message;
    return false;
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
              : 'Code did not match or already expired. Copy the new code and retry.',
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
    this.#session = null;
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

  /** Replaces this device's vault with a backup, protected by a new passphrase. */
  async importBackup(bytes, backupPassword, passphrase, confirmation) {
    if (this.phase !== 'setup' && this.phase !== 'locked') {
      throw new UserError('Lock the vault before restoring a backup');
    }
    checkPassphrase(passphrase, confirmation);
    return this.#guard(async () => {
      const restored = await restoreBackup(bytes, backupPassword);
      const ready = {
        ...restored,
        lastBackupRevision: restored.revision,
        lastAcceptedStep: -1,
        lastAcceptedEnd: 0,
      };
      this.#session = await newSession(passphrase, this.#kdf);
      this.#vault = ready;
      await this.#save();
      await this.#pass.reset();
      await this.#codeTries.reset();
      this.#set('code', 'Backup restored. Pair TBD Codes on this phone, then enter its code.');
      return true;
    });
  }

  async changePassphrase(current, next, confirmation) {
    this.#requireOpen();
    checkPassphrase(next, confirmation);
    const record = await this.#store.get(RECORD_KEY);
    await open(record, FORMAT, current); // throws UserError if wrong
    this.#session = await newSession(next, this.#kdf);
    await this.#save();
  }

  /** Permanently removes the vault from this device. */
  async eraseDevice() {
    await this.#store.clear();
    this.#session = null;
    this.#vault = null;
    this.#set('setup', '');
  }
}

export function checkPassphrase(passphrase, confirmation) {
  if (charCount(passphrase) < MIN_PASSPHRASE) {
    throw new UserError(`Use at least ${MIN_PASSPHRASE} characters. A few random words works well.`);
  }
  if (confirmation !== undefined && passphrase !== confirmation) {
    throw new UserError('The two passphrases do not match');
  }
}

export { MAX_PERIOD, MIN_PERIOD };
