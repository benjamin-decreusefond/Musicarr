import './helpers/env.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRealAuthApp, listen, req } from './helpers/app.js';
import { validatePassword } from '../auth.js';
import { createUser, wipe, db } from './helpers/seed.js';

let srv, ipSeq = 0;
before(async () => { srv = await listen(makeRealAuthApp()); });
after(async () => { await srv.close(); });
beforeEach(() => { wipe(); });

// Each call gets a fresh client IP so the login rate limiter stays isolated.
const ip = () => ({ 'x-forwarded-for': `10.1.0.${++ipSeq}` });
const cookieFrom = (res) => {
  const sc = res.headers.get('set-cookie') || '';
  return sc.split(';')[0]; // "musicarr_session=<token>"
};
async function loginAs(username, password, headers = {}) {
  const r = await req(srv.url, 'POST', '/api/auth/login', { body: { username, password }, headers: { ...ip(), ...headers } });
  return { res: r, cookie: cookieFrom(r) };
}

test('validatePassword enforces presence and length', () => {
  assert.match(validatePassword(''), /required/);
  assert.match(validatePassword(123), /required/);
  assert.match(validatePassword('short'), /8 characters/);
  assert.equal(validatePassword('longenough'), null);
});

test('login: wrong username, wrong password, and success set a cookie', async () => {
  createUser({ username: 'kim', password: 'password1' });
  assert.equal((await loginAs('ghost', 'password1')).res.status, 401);      // unknown user (dummy hash)
  assert.equal((await loginAs('kim', 'wrong')).res.status, 401);            // wrong password
  const ok = await loginAs('kim', 'password1');
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.body.username, 'kim');
  assert.match(ok.cookie, /musicarr_session=/);
});

test('login rate limiting kicks in after too many attempts from one IP', async () => {
  createUser({ username: 'rl', password: 'password1' });
  const fixed = { 'x-forwarded-for': '10.9.9.9' };
  let last;
  for (let i = 0; i < 12; i++) last = await req(srv.url, 'POST', '/api/auth/login', { body: { username: 'rl', password: 'no' }, headers: fixed });
  assert.equal(last.status, 429);
});

test('me reflects the session and logout clears it', async () => {
  createUser({ username: 'sam', password: 'password1' });
  const { cookie } = await loginAs('sam', 'password1');
  assert.equal((await req(srv.url, 'GET', '/api/auth/me')).status, 401); // no cookie
  const me = await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie } });
  assert.equal(me.body.username, 'sam');

  await req(srv.url, 'POST', '/api/auth/logout', { headers: { cookie } });
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie } })).status, 401);
  await req(srv.url, 'POST', '/api/auth/logout'); // logout without a cookie is fine
});

test('expired sessions are rejected and removed', async () => {
  const u = createUser({ username: 'exp', password: 'password1' });
  const { cookie } = await loginAs('exp', 'password1');
  const token = cookie.split('=')[1];
  // Force the stored (hashed) session to be expired.
  db.prepare(`UPDATE sessions SET expires_at = datetime('now','-1 day') WHERE user_id = ?`).run(u.id);
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie } })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0); // pruned
  void token;
});

test('change password: validation, rotation, and sign-out of other sessions', async () => {
  createUser({ username: 'pw', password: 'password1' });
  const a = await loginAs('pw', 'password1');
  const b = await loginAs('pw', 'password1'); // a second session

  assert.equal((await req(srv.url, 'POST', '/api/auth/password', { headers: { cookie: a.cookie }, body: { current: 'nope', next: 'newpassword1' } })).status, 400);
  assert.equal((await req(srv.url, 'POST', '/api/auth/password', { headers: { cookie: a.cookie }, body: { current: 'password1', next: 'short' } })).status, 400);
  assert.equal((await req(srv.url, 'POST', '/api/auth/password', { headers: { cookie: a.cookie }, body: { current: 'password1', next: 'password1' } })).status, 400);

  const ok = await req(srv.url, 'POST', '/api/auth/password', { headers: { cookie: a.cookie }, body: { current: 'password1', next: 'newpassword1' } });
  assert.equal(ok.body.ok, true);
  // The other session was invalidated; the one that changed it still works.
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie: b.cookie } })).status, 401);
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie: a.cookie } })).status, 200);
});

test('change password requires being signed in', async () => {
  assert.equal((await req(srv.url, 'POST', '/api/auth/password', { body: { current: 'x', next: 'y' } })).status, 401);
});

/* ---------------------------------------------------------- API tokens */
test('personal access tokens: create, authenticate, list, and revoke', async () => {
  createUser({ username: 'dev', password: 'password1' });
  const { cookie } = await loginAs('dev', 'password1');

  assert.equal((await req(srv.url, 'POST', '/api/auth/tokens', { headers: { cookie }, body: {} })).status, 400);
  assert.equal((await req(srv.url, 'POST', '/api/auth/tokens', { headers: { cookie }, body: { name: 'x'.repeat(81) } })).status, 400);

  const created = await req(srv.url, 'POST', '/api/auth/tokens', { headers: { cookie }, body: { name: 'CLI' } });
  assert.match(created.body.token, /^mcr_/);
  const raw = created.body.token;

  // The token authenticates via Bearer and via X-Api-Key.
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { authorization: `Bearer ${raw}` } })).status, 200);
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { 'x-api-key': raw } })).status, 200);
  // A second request exercises the last_used_at write throttle.
  await req(srv.url, 'GET', '/api/auth/me', { headers: { 'x-api-key': raw } });
  // An unknown token is simply unauthenticated.
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: { authorization: 'Bearer mcr_nope' } })).status, 401);

  const list = await req(srv.url, 'GET', '/api/auth/tokens', { headers: { cookie } });
  assert.equal(list.body.length, 1);
  const id = list.body[0].id;
  await req(srv.url, 'DELETE', `/api/auth/tokens/${id}`, { headers: { cookie } });
  assert.equal((await req(srv.url, 'GET', '/api/auth/tokens', { headers: { cookie } })).body.length, 0);
});

test('API tokens cannot manage tokens (must use an interactive session)', async () => {
  createUser({ username: 'dev2', password: 'password1' });
  const { cookie } = await loginAs('dev2', 'password1');
  const created = await req(srv.url, 'POST', '/api/auth/tokens', { headers: { cookie }, body: { name: 'CLI' } });
  const raw = created.body.token;
  assert.equal((await req(srv.url, 'GET', '/api/auth/tokens', { headers: { authorization: `Bearer ${raw}` } })).status, 403);
  assert.equal((await req(srv.url, 'GET', '/api/auth/tokens')).status, 401); // not signed in at all
});

test('token creation is capped per user', async () => {
  const u = createUser({ username: 'cap', password: 'password1' });
  const { cookie } = await loginAs('cap', 'password1');
  // Pre-fill to the limit (50) directly, then the API call should be rejected.
  const ins = db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 50; i++) ins.run(u.id, `t${i}`, `hash${i}`, 'mcr_xx');
  assert.match((await req(srv.url, 'POST', '/api/auth/tokens', { headers: { cookie }, body: { name: 'over' } })).body.error, /limit reached/);
});

/* ------------------------------------------------------- Admin: users */
test('user management is admin-gated and validates input', async () => {
  createUser({ username: 'admin', password: 'password1', is_admin: 1 });
  const regular = createUser({ username: 'reg', password: 'password1' });
  const adminC = (await loginAs('admin', 'password1')).cookie;
  const regC = (await loginAs('reg', 'password1')).cookie;

  assert.equal((await req(srv.url, 'GET', '/api/users', { headers: { cookie: regC } })).status, 403); // not admin
  assert.ok((await req(srv.url, 'GET', '/api/users', { headers: { cookie: adminC } })).body.length >= 2);

  assert.equal((await req(srv.url, 'POST', '/api/users', { headers: { cookie: adminC }, body: { username: 'x' } })).status, 400); // missing pw
  assert.equal((await req(srv.url, 'POST', '/api/users', { headers: { cookie: adminC }, body: { username: 'x', password: 'short' } })).status, 400);
  const made = await req(srv.url, 'POST', '/api/users', { headers: { cookie: adminC }, body: { username: 'fresh', password: 'password1', is_admin: true } });
  assert.equal(made.body.is_admin, true);
  assert.equal((await req(srv.url, 'POST', '/api/users', { headers: { cookie: adminC }, body: { username: 'fresh', password: 'password1' } })).status, 409); // dup

  // Delete: can't delete yourself; can delete others.
  const adminId = (await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie: adminC } })).body.id;
  assert.equal((await req(srv.url, 'DELETE', `/api/users/${adminId}`, { headers: { cookie: adminC } })).status, 400);
  assert.equal((await req(srv.url, 'DELETE', `/api/users/${regular.id}`, { headers: { cookie: adminC } })).body.ok, true);
});

test('requireAuth blocks unauthenticated access to protected routes', async () => {
  assert.equal((await req(srv.url, 'GET', '/api/users')).status, 401);
});
