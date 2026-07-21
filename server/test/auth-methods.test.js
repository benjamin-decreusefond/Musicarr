import './helpers/env.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRealAuthApp, listen, req } from './helpers/app.js';
import { bootstrapAdmin } from '../auth.js';
import { createUser, wipe, db } from './helpers/seed.js';

let srv;
before(async () => { srv = await listen(makeRealAuthApp()); });
after(async () => { await srv.close(); });
beforeEach(() => { wipe(); });
// Every test opts into a method explicitly; reset so one can't leak into another
// (and the default — no AUTH_METHOD — stays "login").
afterEach(() => {
  for (const k of ['AUTH_METHOD', 'AUTH_PROXY_HEADER', 'AUTH_PROXY_ADMIN_USERS',
    'AUTH_PROXY_TRUSTED_IPS', 'AUTH_PROXY_LOGOUT_URL']) delete process.env[k];
});

const silentBootstrap = () => { const log = console.log; console.log = () => {}; try { bootstrapAdmin(); } finally { console.log = log; } };
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

/* --------------------------------------------------------- default (login) */
test('default method is login and exposes the new me fields', async () => {
  createUser({ username: 'kim', password: 'password1' });
  const login = await req(srv.url, 'POST', '/api/auth/login',
    { body: { username: 'kim', password: 'password1' }, headers: { 'x-forwarded-for': '10.1.0.1' } });
  assert.equal(login.status, 200);
  const me = await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie: cookieFrom(login) } });
  assert.equal(me.body.auth_method, 'login');
  assert.equal(me.body.auth_via, 'session');
  assert.equal(me.body.can_change_password, true);
  assert.equal(me.body.logout_url, null);
});

/* ------------------------------------------------------------------- none */
test('AUTH_METHOD=none authenticates every request as a shared admin', async () => {
  process.env.AUTH_METHOD = 'none';
  silentBootstrap();
  const me = await req(srv.url, 'GET', '/api/auth/me'); // no cookie at all
  assert.equal(me.status, 200);
  assert.equal(me.body.is_admin, true);
  assert.equal(me.body.auth_method, 'none');
  assert.equal(me.body.auth_via, 'none');
  assert.equal(me.body.can_change_password, false);
  // Login and password changes are meaningless in this mode.
  assert.equal((await req(srv.url, 'POST', '/api/auth/login', { body: { username: 'x', password: 'y' } })).status, 400);
  assert.equal((await req(srv.url, 'POST', '/api/auth/password', { body: { current: 'a', next: 'bbbbbbbb' } })).status, 400);
  // Admin-only routes are reachable (the shared user is an admin).
  assert.equal((await req(srv.url, 'GET', '/api/users')).status, 200);
});

test('AUTH_METHOD=none reuses an existing admin instead of creating another', () => {
  const admin = createUser({ username: 'boss', password: 'password1', is_admin: 1 });
  process.env.AUTH_METHOD = 'none';
  silentBootstrap();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT id FROM users').get().id, admin.id);
});

/* ------------------------------------------------------------------ proxy */
test('AUTH_METHOD=proxy provisions users from the identity header; first is admin', async () => {
  process.env.AUTH_METHOD = 'proxy';
  const alice = await req(srv.url, 'GET', '/api/auth/me', { headers: { 'x-forwarded-user': 'alice' } });
  assert.equal(alice.status, 200);
  assert.equal(alice.body.username, 'alice');
  assert.equal(alice.body.is_admin, true);      // first user ever -> admin
  assert.equal(alice.body.auth_method, 'proxy');
  assert.equal(alice.body.auth_via, 'proxy');
  assert.equal(alice.body.can_change_password, false);
  // A later user is a normal (non-admin) account.
  const bob = await req(srv.url, 'GET', '/api/auth/me', { headers: { 'x-forwarded-user': 'bob' } });
  assert.equal(bob.body.username, 'bob');
  assert.equal(bob.body.is_admin, false);
  // No header -> not authenticated.
  assert.equal((await req(srv.url, 'GET', '/api/auth/me')).status, 401);
  // Password changes are rejected for a proxy-owned identity.
  assert.equal((await req(srv.url, 'POST', '/api/auth/password',
    { headers: { 'x-forwarded-user': 'alice' }, body: { current: 'a', next: 'bbbbbbbb' } })).status, 400);
});

test('AUTH_PROXY_ADMIN_USERS grants and syncs admin; a custom header is honoured', async () => {
  process.env.AUTH_METHOD = 'proxy';
  process.env.AUTH_PROXY_HEADER = 'remote-user';
  process.env.AUTH_PROXY_ADMIN_USERS = 'carol, erin';
  createUser({ username: 'seed' });                 // so newcomers aren't "first ever"
  const erin = createUser({ username: 'erin' });    // exists, currently non-admin
  // Listed admin, provisioned fresh via the custom header.
  const carol = await req(srv.url, 'GET', '/api/auth/me', { headers: { 'remote-user': 'carol' } });
  assert.equal(carol.body.username, 'carol');
  assert.equal(carol.body.is_admin, true);
  // Existing user gets promoted to admin because it's now in the list.
  const erinMe = await req(srv.url, 'GET', '/api/auth/me', { headers: { 'remote-user': 'erin' } });
  assert.equal(erinMe.body.is_admin, true);
  assert.equal(db.prepare('SELECT is_admin FROM users WHERE id = ?').get(erin.id).is_admin, 1);
  // Not listed and not first -> stays a normal user.
  const dave = await req(srv.url, 'GET', '/api/auth/me', { headers: { 'remote-user': 'dave' } });
  assert.equal(dave.body.is_admin, false);
});

test('AUTH_PROXY_TRUSTED_IPS gates whether the header is honoured', async () => {
  process.env.AUTH_METHOD = 'proxy';
  const hdr = { 'x-forwarded-user': 'gina' };
  process.env.AUTH_PROXY_TRUSTED_IPS = '10.9.9.9';   // not our loopback peer
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: hdr })).status, 401);
  process.env.AUTH_PROXY_TRUSTED_IPS = '127.0.0.1';  // the real TCP peer
  assert.equal((await req(srv.url, 'GET', '/api/auth/me', { headers: hdr })).status, 200);
});

test('AUTH_PROXY_LOGOUT_URL is surfaced to proxy-authenticated clients', async () => {
  process.env.AUTH_METHOD = 'proxy';
  process.env.AUTH_PROXY_LOGOUT_URL = '/oauth2/sign_out';
  const me = await req(srv.url, 'GET', '/api/auth/me', { headers: { 'x-forwarded-user': 'harry' } });
  assert.equal(me.body.logout_url, '/oauth2/sign_out');
});

test('proxy mode still lets direct clients use native login and API tokens', async () => {
  process.env.AUTH_METHOD = 'proxy';
  createUser({ username: 'dev', password: 'password1' });
  // A desktop client can sign in directly with a password.
  const login = await req(srv.url, 'POST', '/api/auth/login',
    { body: { username: 'dev', password: 'password1' }, headers: { 'x-forwarded-for': '10.1.2.3' } });
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);
  const me = await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie } });
  assert.equal(me.body.auth_via, 'session');
  assert.equal(me.body.can_change_password, true);   // a native session has a password
  // ...and mint an API token for a headless client.
  const tok = await req(srv.url, 'POST', '/api/auth/tokens', { headers: { cookie }, body: { name: 'Client' } });
  const raw = tok.body.token;
  const viaToken = await req(srv.url, 'GET', '/api/auth/me', { headers: { authorization: `Bearer ${raw}` } });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.body.auth_via, 'token');
  // A client's own credentials win over a (spoofable) identity header.
  const both = await req(srv.url, 'GET', '/api/auth/me', { headers: { cookie, 'x-forwarded-user': 'someone-else' } });
  assert.equal(both.body.username, 'dev');
  assert.equal(both.body.auth_via, 'session');
});

/* -------------------------------------------------------- bootstrap logging */
test('bootstrapAdmin in proxy mode: no seed admin unless ADMIN_PASSWORD is set', () => {
  process.env.AUTH_METHOD = 'proxy';
  silentBootstrap();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0); // provisioned on request
  process.env.ADMIN_PASSWORD = 'break-glass-pass';
  try {
    silentBootstrap(); // now seeds a break-glass native admin
    const admin = db.prepare('SELECT * FROM users').get();
    assert.ok(admin);
    assert.equal(admin.is_admin, 1);
  } finally { delete process.env.ADMIN_PASSWORD; }
});
