// Failed-attempt limiter. After `maxFailures` misses entry is blocked, and each
// repeat block is twice as long (up to 10 minutes). State survives a restart.
// Unreadable state is treated as blocked, not as "no failures".

export class AttemptLimiter {
  constructor(store, name, clock = Date.now, { maxFailures = 5, baseMs = 30000, capMs = 600000 } = {}) {
    this.store = store;
    this.key = `attempts:${name}`;
    this.clock = clock;
    this.maxFailures = maxFailures;
    this.baseMs = baseMs;
    this.capMs = capMs;
  }

  async #read() {
    const raw = await this.store.get(this.key);
    if (raw === undefined) return { failures: 0, rounds: 0, blockedUntil: 0 };
    const ok =
      raw && Number.isSafeInteger(raw.failures) && Number.isSafeInteger(raw.rounds) &&
      Number.isSafeInteger(raw.blockedUntil) && raw.failures >= 0 && raw.rounds >= 0;
    if (ok) return raw;
    // Persist the block so it ends on schedule instead of restarting on each read.
    const blocked = { failures: 0, rounds: 1, blockedUntil: this.clock() + this.baseMs };
    await this.store.set(this.key, blocked);
    return blocked;
  }

  /** Seconds the user must still wait, or 0 if entry is allowed. */
  async waitSeconds() {
    const { blockedUntil } = await this.#read();
    const left = blockedUntil - this.clock();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Records a miss. Returns the wait in seconds if this miss caused a block. */
  async fail() {
    const state = await this.#read();
    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      const wait = Math.min(this.baseMs * 2 ** state.rounds, this.capMs);
      state.failures = 0;
      state.rounds += 1;
      state.blockedUntil = this.clock() + wait;
    }
    await this.store.set(this.key, state);
    return state.blockedUntil > this.clock() ? Math.ceil((state.blockedUntil - this.clock()) / 1000) : 0;
  }

  async reset() {
    await this.store.set(this.key, { failures: 0, rounds: 0, blockedUntil: 0 });
  }
}
