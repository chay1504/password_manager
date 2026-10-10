import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttemptLimiter } from '../shared/limiter.js';
import { memoryStore } from '../shared/store.js';
import { fakeClock } from './helpers.mjs';

test('five misses block for 30 s, then 60 s, and success resets', async () => {
  const clock = fakeClock();
  const lim = new AttemptLimiter(memoryStore(), 't', clock);
  for (let i = 0; i < 4; i++) assert.equal(await lim.fail(), 0);
  assert.equal(await lim.fail(), 30);
  assert.equal(await lim.waitSeconds(), 30);
  clock.advance(31_000);
  assert.equal(await lim.waitSeconds(), 0);
  for (let i = 0; i < 4; i++) await lim.fail();
  assert.equal(await lim.fail(), 60);
  await lim.reset();
  assert.equal(await lim.waitSeconds(), 0);
});

test('block survives a restart (new limiter, same store)', async () => {
  const clock = fakeClock();
  const store = memoryStore();
  const first = new AttemptLimiter(store, 't', clock);
  for (let i = 0; i < 5; i++) await first.fail();
  assert.equal(await new AttemptLimiter(store, 't', clock).waitSeconds(), 30);
});

test('corrupt state blocks briefly, then clears on schedule', async () => {
  const clock = fakeClock();
  const store = memoryStore();
  await store.set('attempts:t', 'garbage');
  const lim = new AttemptLimiter(store, 't', clock);
  assert.equal(await lim.waitSeconds(), 30);
  clock.advance(31_000);
  assert.equal(await lim.waitSeconds(), 0);
});
