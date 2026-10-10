// TBD Codes logic, independent of the screen so it can be tested.
// Phases: loading -> setup | locked | legacy -> show
// Protected by face lock only.
import { openWithKey, sealWithKey } from '../shared/crypto.js';
import { PERIODS, code as makeCode, msLeft } from '../shared/otp.js';
import { decodePairing } from '../shared/pairing.js';
import { FormatException, UserError, fromB64, toB64 } from '../shared/util.js';

export const FORMAT = 'TBD-WEB-CODES-v2';
const RECORD_KEY = 'seed';

export class CodesController extends EventTarget {
  #store;
  #clock;
  #face;
  #key = null;
  #secret = null;

  phase = 'loading';
  period = 10;
  busy = false;
  message = '';

  constructor(store, face, { clock = Date.now } = {}) {
    super();
    this.#store = store;
    this.#face = face;
    this.#clock = clock;
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

  async init() {
    try {
      const record = await this.#store.get(RECORD_KEY);
      this.#set(!record ? 'setup' : record.format === FORMAT ? 'locked' : 'legacy');
    } catch {
      this.#set('error', 'This browser cannot store data privately. Try another browser.');
    }
  }

  async #save() {
    await this.#store.set(
      RECORD_KEY,
      await sealWithKey(this.#key, FORMAT, { secret: toB64(this.#secret), period: this.period }),
    );
  }

  /** Saves the key text and sets up face lock. */
  async add(keyText) {
    if (this.phase !== 'setup') return false;
    let parsed;
    try {
      parsed = decodePairing(keyText);
    } catch (error) {
      throw error instanceof FormatException ? new UserError(error.message) : error;
    }
    return this.#guard(async () => {
      this.#key = await this.#face.enroll();
      this.#secret = parsed.secret;
      this.period = parsed.period;
      await this.#save();
      this.#set('show', '');
      return true;
    });
  }

  async unlock() {
    if (this.phase !== 'locked') return false;
    return this.#guard(async () => {
      try {
        const key = await this.#face.unlock();
        const object = await openWithKey(key, await this.#store.get(RECORD_KEY), FORMAT);
        const secret = fromB64(object.secret);
        if (secret.length !== 32 || !PERIODS.includes(object.period)) throw new FormatException('bad');
        this.#key = key;
        this.#secret = secret;
        this.period = object.period;
      } catch (error) {
        this.message = error instanceof UserError ? error.message : 'Could not open the saved key. Remove it and add it again.';
        return false;
      }
      this.#set('show', '');
      return true;
    });
  }

  lock() {
    if (this.phase !== 'show') return;
    this.#secret?.fill(0);
    this.#secret = null;
    this.#key = null;
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
    this.#key = null;
    this.#set('setup', '');
  }
}
