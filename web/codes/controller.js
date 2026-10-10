// TBD Codes logic, independent of the screen so it can be tested.
// Phases: loading -> setup | locked -> show
import { LOCAL_KDF, newSession, open, seal } from '../shared/crypto.js';
import { AttemptLimiter } from '../shared/limiter.js';
import { PERIODS, code as makeCode, msLeft } from '../shared/otp.js';
import { decodePairing } from '../shared/pairing.js';
import { FormatException, UserError, charCount, fromB64, toB64 } from '../shared/util.js';

export const FORMAT = 'TBD-WEB-CODES-v1';
export const MIN_APP_PASSPHRASE = 6;
const RECORD_KEY = 'seed';

export class CodesController extends EventTarget {
  #store;
  #clock;
  #kdf;
  #session = null;
  #secret = null;
  #limiter;

  phase = 'loading';
  period = 10;
  busy = false;
  message = '';

  constructor(store, { clock = Date.now, kdf = LOCAL_KDF } = {}) {
    super();
    this.#store = store;
    this.#clock = clock;
    this.#kdf = kdf;
    this.#limiter = new AttemptLimiter(store, 'unlock', clock);
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
    const record = await seal(this.#session, FORMAT, {
      secret: toB64(this.#secret),
      period: this.period,
    });
    await this.#store.set(RECORD_KEY, record);
  }

  /** Pairs with TBD Vault from its pairing code and sets this app's passphrase. */
  async pair(pairingText, passphrase, confirmation) {
    if (this.phase !== 'setup') return false;
    if (charCount(passphrase) < MIN_APP_PASSPHRASE) {
      throw new UserError(`Use at least ${MIN_APP_PASSPHRASE} characters for the app passphrase`);
    }
    if (passphrase !== confirmation) throw new UserError('The two passphrases do not match');
    let parsed;
    try {
      parsed = decodePairing(pairingText);
    } catch (error) {
      throw error instanceof FormatException ? new UserError(error.message) : error;
    }
    return this.#guard(async () => {
      this.#session = await newSession(passphrase, this.#kdf);
      this.#secret = parsed.secret;
      this.period = parsed.period;
      await this.#save();
      await this.#limiter.reset();
      this.#set('show', '');
      return true;
    });
  }

  async unlock(passphrase) {
    if (this.phase !== 'locked') return false;
    return this.#guard(async () => {
      const wait = await this.#limiter.waitSeconds();
      if (wait > 0) {
        this.message = `Too many tries. Wait ${wait} seconds.`;
        return false;
      }
      try {
        const { session, object } = await open(await this.#store.get(RECORD_KEY), FORMAT, passphrase);
        const secret = fromB64(object.secret);
        if (secret.length !== 32 || !PERIODS.includes(object.period)) throw new FormatException('bad');
        this.#session = session;
        this.#secret = secret;
        this.period = object.period;
      } catch (error) {
        if (error instanceof UserError) {
          const blocked = await this.#limiter.fail();
          this.message = blocked ? `Too many tries. Wait ${blocked} seconds.` : 'Wrong passphrase.';
        } else {
          this.message = 'Could not open the saved pairing. Pair again.';
        }
        return false;
      }
      await this.#limiter.reset();
      this.#set('show', '');
      return true;
    });
  }

  lock() {
    if (this.phase !== 'show') return;
    this.#secret?.fill(0);
    this.#secret = null;
    this.#session = null;
    this.#set('locked', '');
  }

  async setPeriod(period) {
    if (this.phase !== 'show' || !PERIODS.includes(period)) throw new UserError('Choose 5 to 10 seconds');
    this.period = period;
    await this.#save();
    this.dispatchEvent(new Event('change'));
  }

  /** The current code and how long it stays valid. Only while unlocked. */
  async current() {
    if (this.phase !== 'show' || !this.#secret) return null;
    const now = this.#clock();
    return { code: await makeCode(this.#secret, now, this.period), msLeft: msLeft(now, this.period) };
  }

  async eraseDevice() {
    await this.#store.clear();
    this.#secret = null;
    this.#session = null;
    this.#set('setup', '');
  }
}
