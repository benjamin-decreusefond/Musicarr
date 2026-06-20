import './helpers/env.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthedApp, listen, req, setUser } from './helpers/app.js';
import { createUser, addTrack, wipe, db } from './helpers/seed.js';

let srv, alice, bob;
before(async () => { srv = await listen(makeAuthedApp()); });
after(async () => { await srv.close(); });
beforeEach(() => {
  wipe();
  alice = createUser({ username: 'alice' });
  bob = createUser({ username: 'bob', is_admin: 1 });
  setUser({ id: alice.id, username: 'alice', is_admin: 0 });
});

test('heartbeat upserts now_playing (valid and invalid track id)', async () => {
  addTrack({ deezer_id: 1, file_path: '/a.flac' });
  let r = await req(srv.url, 'POST', '/api/social/heartbeat', { body: { track_id: 1 } });
  assert.equal(r.body.ok, true);
  r = await req(srv.url, 'POST', '/api/social/heartbeat', { body: { track_id: 'x' } }); // -> null
  assert.equal(r.body.ok, true);
});

test('users search and default listing, with now-playing surfaced', async () => {
  addTrack({ deezer_id: 5, title: 'Live', file_path: '/b.flac' });
  db.prepare(`INSERT INTO now_playing (user_id, track_id, updated_at) VALUES (?, ?, datetime('now'))`).run(bob.id, 5);
  db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(alice.id, bob.id);

  const list = await req(srv.url, 'GET', '/api/social/users');
  assert.ok(list.body.find(u => u.username === 'bob').nowPlaying);
  assert.equal(list.body.find(u => u.username === 'bob').following, true);

  const search = await req(srv.url, 'GET', '/api/social/users?q=bo');
  assert.equal(search.body.length, 1);
  assert.equal(search.body[0].username, 'bob');
});

test('following list returns followed users with last played', async () => {
  db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(alice.id, bob.id);
  addTrack({ deezer_id: 9, file_path: '/c.flac' });
  db.prepare(`INSERT INTO plays (user_id, track_id) VALUES (?, ?)`).run(bob.id, 9);
  const r = await req(srv.url, 'GET', '/api/social/following');
  assert.equal(r.body[0].username, 'bob');
  assert.equal(r.body[0].lastPlayed.id, 9);
});

test('follow / unfollow with validation', async () => {
  assert.equal((await req(srv.url, 'POST', `/api/social/follow/${alice.id}`)).status, 400); // self
  assert.equal((await req(srv.url, 'POST', '/api/social/follow/99999')).status, 404);        // missing
  assert.equal((await req(srv.url, 'POST', '/api/social/follow/abc')).status, 400);           // NaN
  const ok = await req(srv.url, 'POST', `/api/social/follow/${bob.id}`);
  assert.equal(ok.body.ok, true);
  assert.ok(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(alice.id, bob.id));
  await req(srv.url, 'DELETE', `/api/social/follow/${bob.id}`);
  assert.ok(!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(alice.id, bob.id));
});

test('user profile with recents, favorites, playlists (+ cover) and not-found', async () => {
  assert.equal((await req(srv.url, 'GET', '/api/social/users/99999')).status, 404);

  addTrack({ deezer_id: 11, cover: 'pl-cover.jpg', file_path: '/d.flac' });
  db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(bob.id, 11);
  db.prepare('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)').run(bob.id, 11);
  const pl = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(bob.id, 'Bobs');
  db.prepare('INSERT INTO playlist_items (playlist_id, position, track_id) VALUES (?, 0, 11)').run(pl.lastInsertRowid);

  const r = await req(srv.url, 'GET', `/api/social/users/${bob.id}`);
  assert.equal(r.body.username, 'bob');
  assert.equal(r.body.recent[0].deezer_id, 11);
  assert.equal(r.body.favorites[0].deezer_id, 11);
  assert.equal(r.body.playlists[0].count, 1);
  assert.equal(r.body.playlists[0].cover, 'pl-cover.jpg');
});
