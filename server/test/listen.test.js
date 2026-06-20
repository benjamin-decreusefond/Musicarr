import './helpers/env.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthedApp, listen, req, setUser } from './helpers/app.js';
import { createUser, addTrack, wipe, db } from './helpers/seed.js';

let srv, host, guest;
before(async () => { srv = await listen(makeAuthedApp()); });
after(async () => { await srv.close(); });
beforeEach(() => {
  wipe();
  host = createUser({ username: 'host' });
  guest = createUser({ username: 'guest' });
  setUser({ id: host.id, username: 'host', is_admin: 0 });
});

const asHost = () => setUser({ id: host.id, username: 'host', is_admin: 0 });
const asGuest = () => setUser({ id: guest.id, username: 'guest', is_admin: 0 });

test('active returns inactive then the joined session', async () => {
  assert.equal((await req(srv.url, 'GET', '/api/listen/active')).body.active, false);
  const s = await req(srv.url, 'POST', '/api/listen/start');
  const active = await req(srv.url, 'GET', '/api/listen/active');
  assert.equal(active.body.active, true);
  assert.equal(active.body.session.code, s.body.code);
});

test('start is idempotent for the same host', async () => {
  const a = await req(srv.url, 'POST', '/api/listen/start');
  const b = await req(srv.url, 'POST', '/api/listen/start');
  assert.equal(a.body.code, b.body.code);
  assert.equal(a.body.is_host, true);
});

test('join validates the code and adds the guest', async () => {
  const s = await req(srv.url, 'POST', '/api/listen/start');
  asGuest();
  assert.equal((await req(srv.url, 'POST', '/api/listen/join', { body: {} })).status, 400);
  assert.equal((await req(srv.url, 'POST', '/api/listen/join', { body: { code: 'ZZZZZZ' } })).status, 404);
  const joined = await req(srv.url, 'POST', '/api/listen/join', { body: { code: s.body.code } });
  assert.equal(joined.body.members.length, 2);
  // Re-joining the same session is fine (ON CONFLICT refresh).
  assert.equal((await req(srv.url, 'POST', '/api/listen/join', { body: { code: s.body.code } })).status, 200);
});

test('poll enforces membership and surfaces track metadata', async () => {
  addTrack({ deezer_id: 3, title: 'Sync', file_path: '/s.flac' });
  const s = await req(srv.url, 'POST', '/api/listen/start');
  const id = s.body.id;
  // Host sets state including a track.
  await req(srv.url, 'POST', `/api/listen/${id}/state`, { body: { track_id: 3, position: 12.5, is_playing: true } });

  assert.equal((await req(srv.url, 'GET', '/api/listen/999')).status, 404);
  const polled = await req(srv.url, 'GET', `/api/listen/${id}`);
  assert.equal(polled.body.track.deezer_id, 3);
  assert.equal(polled.body.is_playing, true);

  asGuest();
  assert.equal((await req(srv.url, 'GET', `/api/listen/${id}`)).status, 403); // not a member
});

test('state updates are host-only', async () => {
  const s = await req(srv.url, 'POST', '/api/listen/start');
  const id = s.body.id;
  assert.equal((await req(srv.url, 'POST', '/api/listen/999/state', { body: {} })).status, 404);

  asGuest();
  await req(srv.url, 'POST', '/api/listen/join', { body: { code: s.body.code } });
  assert.equal((await req(srv.url, 'POST', `/api/listen/${id}/state`, { body: { position: 1 } })).status, 403);

  asHost();
  const ok = await req(srv.url, 'POST', `/api/listen/${id}/state`, { body: { track_id: null, position: -3, is_playing: false } });
  assert.equal(ok.body.ok, true);
  assert.equal(db.prepare('SELECT position FROM listen_sessions WHERE id = ?').get(id).position, 0); // clamped
});

test('leave: a guest leaves, the host ends the session, and leaving a dead session is a no-op', async () => {
  const s = await req(srv.url, 'POST', '/api/listen/start');
  const id = s.body.id;
  asGuest();
  await req(srv.url, 'POST', '/api/listen/join', { body: { code: s.body.code } });
  await req(srv.url, 'POST', `/api/listen/${id}/leave`);
  assert.ok(!db.prepare('SELECT 1 FROM listen_members WHERE session_id = ? AND user_id = ?').get(id, guest.id));

  asHost();
  await req(srv.url, 'POST', `/api/listen/${id}/leave`);            // host -> session deleted
  assert.ok(!db.prepare('SELECT 1 FROM listen_sessions WHERE id = ?').get(id));
  assert.equal((await req(srv.url, 'POST', `/api/listen/${id}/leave`)).body.ok, true); // already gone
});
