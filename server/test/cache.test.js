import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.js';

test('get/set with TTL expiry', async () => {
  let now = 1000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const c = createCache({ ttlMs: 100 });
    assert.equal(c.get('a'), undefined);          // miss
    c.set('a', 42);
    assert.equal(c.get('a'), 42);                 // hit
    assert.equal(c.size, 1);
    now += 200;                                   // expire
    assert.equal(c.get('a'), undefined);
    assert.equal(c.size, 0);                      // expired entry was deleted
  } finally { Date.now = realNow; }
});

test('LRU eviction at the size cap and refresh on access', () => {
  const c = createCache({ ttlMs: 10_000, max: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');            // refresh a -> b is now oldest
  c.set('c', 3);         // evicts b
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
});

test('wrap caches, returns cached value, and de-dupes concurrent misses', async () => {
  const c = createCache({ ttlMs: 10_000 });
  let calls = 0;
  const fn = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return 'v'; };

  const [a, b] = await Promise.all([c.wrap('k', fn), c.wrap('k', fn)]); // de-dupe
  assert.equal(a, 'v');
  assert.equal(b, 'v');
  assert.equal(calls, 1);

  const again = await c.wrap('k', fn);  // served from cache
  assert.equal(again, 'v');
  assert.equal(calls, 1);
});

test('wrap clears inflight entry when the function rejects', async () => {
  const c = createCache({ ttlMs: 10_000 });
  await assert.rejects(c.wrap('k', async () => { throw new Error('boom'); }), /boom/);
  // A later call must re-run (the failed inflight promise was cleared).
  const v = await c.wrap('k', async () => 'ok');
  assert.equal(v, 'ok');
});
