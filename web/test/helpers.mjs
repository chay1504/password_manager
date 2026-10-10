export const FAST_KDF = { m: 8192, t: 1, p: 1 };

export function fakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 3)) {
  const clock = () => clock.now;
  clock.now = start;
  clock.advance = (ms) => (clock.now += ms);
  return clock;
}

import { newDeviceKey } from '../shared/crypto.js';
import { UserError } from '../shared/util.js';

/** Stands in for the phone's face lock: same interface as shared/face.js. */
export class FakeFace {
  key = null;
  refuse = false;

  async enroll() {
    if (this.refuse) throw new UserError('Face unlock was cancelled or not recognised. Try again.');
    this.key = await newDeviceKey();
    return this.key;
  }

  async unlock() {
    if (this.refuse || !this.key) throw new UserError('Face unlock was cancelled or not recognised. Try again.');
    return this.key;
  }

  async mode() {
    return this.key ? 'strong' : null;
  }
}
