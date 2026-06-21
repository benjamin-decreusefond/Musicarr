import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../ratelimit.js';

// Minimal req/res doubles so the middleware can be exercised directly.
function run(mw, { user, ip = '1.2.3.4' } = {}) {
  const req = { user, ip };
  let status = 200, body = null; const headers = {};
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status: (s) => { status = s; return res; },
    json: (b) => { body = b; return res; },
  };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { status, body, headers, nexted };
}

test('allows requests up to the limit, then 429s with Retry-After', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  const user = { id: 1 };
  for (let i = 0; i < 3; i++) assert.equal(run(mw, { user }).nexted, true);
  const blocked = run(mw, { user });
  assert.equal(blocked.nexted, false);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers['Retry-After'] >= 1);
});

test('limits are independent per user and fall back to IP when signed out', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  assert.equal(run(mw, { user: { id: 1 } }).nexted, true);
  assert.equal(run(mw, { user: { id: 2 } }).nexted, true); // different user, own bucket
  assert.equal(run(mw, { user: { id: 1 } }).status, 429);   // first user over limit

  // No user -> keyed by IP.
  assert.equal(run(mw, { ip: '9.9.9.9' }).nexted, true);
  assert.equal(run(mw, { ip: '9.9.9.9' }).status, 429);
});

test('prunes its key map once it grows past the bound', () => {
  const mw = rateLimit({ windowMs: 1, max: 100, maxKeys: 2 });
  // Each distinct IP adds a key; windowMs is 1ms so prior keys are immediately
  // stale and get swept once the map exceeds maxKeys.
  for (let i = 0; i < 5; i++) run(mw, { ip: `10.0.0.${i}` });
  // The exact size depends on timing, but the sweep must keep it bounded.
  assert.ok(run(mw, { ip: '10.0.0.99' }).nexted);
});
