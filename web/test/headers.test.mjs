import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { vercelConfig } from '../scripts/headers.mjs';

test('Git-linked Vercel deployments use the reviewed security headers', async () => {
  const actual = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(actual, vercelConfig());
});
