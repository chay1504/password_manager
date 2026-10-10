export const FAST_KDF = { m: 8192, t: 1, p: 1 };

export function fakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 3)) {
  const clock = () => clock.now;
  clock.now = start;
  clock.advance = (ms) => (clock.now += ms);
  return clock;
}
