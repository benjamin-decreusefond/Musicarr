import './helpers/env.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, setSetting } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { makeAuthedApp, listen, req, setUser } from './helpers/app.js';
import { createUser, addTrack, wipe, db } from './helpers/seed.js';

let srv, admin, user;
// Globally-unique Deezer ids so the URL-keyed metadata cache never serves stale
// data between tests in this process.
let UID = 1000;
const uid = () => UID++;

before(async () => { srv = await listen(makeAuthedApp()); });
after(async () => { await srv.close(); });
beforeEach(() => {
  wipe();
  fm.install();
  config.maxConcurrentDownloads = 0;        // queueDownload only writes its row
  setSetting('slskd_url', 'https://slskd.test');
  setSetting('slskd_api_key', 'k');
  admin = createUser({ username: 'admin', is_admin: 1 });
  user = createUser({ username: 'user' });
  asAdmin();
});
const asAdmin = () => setUser({ id: admin.id, username: 'admin', is_admin: 1 });
const asUser = () => setUser({ id: user.id, username: 'user', is_admin: 0 });

/* --------------------------------------------------------------- Settings */
test('settings: read, admin gate, and validated updates', async () => {
  asUser();
  assert.equal((await req(srv.url, 'GET', '/api/settings')).status, 403);
  asAdmin();
  const cur = await req(srv.url, 'GET', '/api/settings');
  assert.equal(cur.body.slskd_api_key_set, true);
  assert.match(cur.body.slskd_api_key_hint, /••••/);

  const root = path.join(config.dataDir, 'lib-root');
  const ok = await req(srv.url, 'PUT', '/api/settings', { body: {
    root_folder: root, slskd_url: 'https://new.slskd', slskd_api_key: 'newkey',
    slskd_download_dir: path.join(config.dataDir, 'dl2'), cleanup_enabled: true, cleanup_after_days: 14,
  } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cleanup_after_days, 14);

  // Clearing the key, and validation failures.
  await req(srv.url, 'PUT', '/api/settings', { body: { slskd_api_key_clear: true } });
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { root_folder: '' } })).body.error, /required/);
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { root_folder: 'relative/path' } })).body.error, /absolute/);
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { slskd_url: 'ftp://x' } })).body.error, /http/);
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { slskd_download_dir: 'rel' } })).body.error, /absolute/);
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { cleanup_after_days: -1 } })).body.error, /0 or more/);
});

test('settings: root folder / download dir that cannot be created are rejected', async () => {
  const aFile = path.join(config.dataDir, 'a-file');
  fs.writeFileSync(aFile, 'x');
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { root_folder: path.join(aFile, 'sub') } })).body.error, /not writable/);
  assert.match((await req(srv.url, 'PUT', '/api/settings', { body: { slskd_download_dir: path.join(aFile, 'sub') } })).body.error, /not accessible/);
});

test('settings/cleanup-now and settings/test', async () => {
  const clean = await req(srv.url, 'POST', '/api/settings/cleanup-now');
  assert.equal(clean.body.ok, true); // cleanup disabled -> 0 removed

  fm.on('slskd.test/api/v0/session', () => fm.json({}, 200));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected' }));
  const t = await req(srv.url, 'POST', '/api/settings/test', { body: { section: 'slskd' } });
  assert.match(t.body.detail, /Connected/);
  assert.equal((await req(srv.url, 'POST', '/api/settings/test', { body: { section: 'other' } })).status, 400);

  fm.reset(); fm.install();
  fm.on('slskd.test/api/v0/session', () => fm.json({}, 401));
  assert.equal((await req(srv.url, 'POST', '/api/settings/test', { body: { section: 'slskd', slskd_url: 'https://slskd.test', slskd_api_key: 'x' } })).status, 400);
});

/* ----------------------------------------------------------- Library/search */
test('library lists on-disk and in-flight tracks; library/artists fetches and caches pictures', async () => {
  const a = addTrack({ deezer_id: uid(), artist_id: 4242, file_path: '/x.flac' });
  let calls = 0;
  fm.on(`deezer.test/artist/4242`, () => { calls++; return { picture_medium: 'pic' }; });
  const lib = await req(srv.url, 'GET', '/api/library');
  assert.ok(lib.body.find(t => t.deezer_id === a.deezer_id));
  const artists = await req(srv.url, 'GET', '/api/library/artists');
  assert.equal(artists.body[0].picture, 'pic');
  assert.equal(calls, 1);
  // The picture is now cached in the artists table.
  assert.equal(db.prepare('SELECT picture FROM artists WHERE id = 4242').get().picture, 'pic');

  // Artist picture fetch failure falls back to null.
  wipe(); addTrack({ deezer_id: uid(), artist_id: 5252, file_path: '/y.flac' });
  fm.on(`deezer.test/artist/5252`, () => { throw new Error('x'); });
  assert.equal((await req(srv.url, 'GET', '/api/library/artists')).body[0].picture, null);
});

test('library/artists serves cached pictures without hitting Deezer', async () => {
  // Pre-cache an artist picture; with no fetch route registered, any Deezer call
  // would throw — so a successful response proves it came from the cache.
  db.prepare('INSERT INTO artists (id, name, picture) VALUES (7000, ?, ?)').run('Pre', 'cached.jpg');
  addTrack({ deezer_id: uid(), artist_id: 7000, file_path: '/c.flac' });
  const r = await req(srv.url, 'GET', '/api/library/artists');
  assert.equal(r.body.find(x => x.id === 7000).picture, 'cached.jpg');
});

test('search: empty query, results, and upstream failure', async () => {
  const empty = await req(srv.url, 'GET', '/api/search');
  assert.deepEqual(empty.body, { artists: [], albums: [], tracks: [] });

  const al = uid(), tr = uid();
  addTrack({ deezer_id: tr, album_id: al, file_path: '/z.flac' });
  fm.on('deezer.test/search/artist', () => ({ data: [{ id: 1, name: 'A', picture_medium: 'p', nb_fan: 9 }] }));
  fm.on('deezer.test/search/album', () => ({ data: [{ id: al, title: 'Al', artist: { name: 'A', id: 1 }, cover_medium: 'c', nb_tracks: 3 }] }));
  fm.on('deezer.test/search/track', () => ({ data: [{ id: tr, title: 'T', artist: { name: 'A', id: 1 }, contributors: [{ id: 2, name: 'B' }], album: { title: 'Al', id: al, cover_medium: 'c' }, duration: 100 }] }));
  const r = await req(srv.url, 'GET', '/api/search?q=hello');
  assert.equal(r.body.albums[0].available, true);
  assert.equal(r.body.tracks[0].available, true);
  assert.equal(r.body.tracks[0].contributors[0].name, 'B');

  fm.reset(); fm.install();
  fm.on('deezer.test/search/artist', () => { throw new Error('down'); });
  fm.on('deezer.test/search/album', () => ({ data: [] }));
  fm.on('deezer.test/search/track', () => ({ data: [] }));
  assert.equal((await req(srv.url, 'GET', '/api/search?q=x')).status, 502);
});

test('artist / album / deezer-playlist browse endpoints + validation', async () => {
  assert.equal((await req(srv.url, 'GET', '/api/artist/0')).status, 400);
  const id = uid();
  fm.on(new RegExp(`artist/${id}$`), () => ({ id, name: 'N', picture_xl: 'xl', nb_fan: 5 }));
  fm.on(`deezer.test/artist/${id}/top`, () => ({ data: [{ id: 7, title: 'T', album: { title: 'Al', id: 3, cover_medium: 'c' }, duration: 10 }] }));
  fm.on(`deezer.test/artist/${id}/albums`, () => ({ data: [{ id: 3, title: 'Al', cover_medium: 'c', nb_tracks: 2, release_date: '2020', record_type: 'album' }] }));
  fm.on(`deezer.test/artist/${id}/related`, () => ({ data: [{ id: 8, name: 'R', picture_medium: 'p' }] }));
  const art = await req(srv.url, 'GET', `/api/artist/${id}`);
  assert.equal(art.body.artist.name, 'N');
  assert.equal(art.body.top.length, 1);

  const alId = uid();
  fm.on(`deezer.test/album/${alId}`, () => ({ id: alId, title: 'Al', artist: { name: 'A', id: 1 }, cover_big: 'cb', nb_tracks: 1, tracks: { data: [{ id: 9, title: 'S', artist: { name: 'A', id: 1 }, contributors: [], duration: 5, track_position: 1 }] } }));
  const alb = await req(srv.url, 'GET', `/api/album/${alId}`);
  assert.equal(alb.body.tracks[0].id, 9);
  assert.equal((await req(srv.url, 'GET', '/api/album/0')).status, 400);

  const plId = uid();
  fm.on(`deezer.test/playlist/${plId}`, () => ({ id: plId, title: 'PL', picture_big: 'pb', creator: { name: 'C' }, nb_tracks: 1, tracks: { data: [{ id: 10, title: 'S', artist: { name: 'A', id: 1 }, contributors: [], album: { title: 'Al', id: 3, cover_medium: 'c' }, duration: 5 }] } }));
  const pl = await req(srv.url, 'GET', `/api/deezer-playlist/${plId}`);
  assert.equal(pl.body.by, 'C');
  assert.equal((await req(srv.url, 'GET', '/api/deezer-playlist/0')).status, 400);

  fm.on('deezer.test/artist/999999', () => { throw new Error('boom'); });
  assert.equal((await req(srv.url, 'GET', '/api/artist/999999')).status, 502);
});

test('following: list, follow (seeds back-catalogue on first), unfollow, validation', async () => {
  asUser();
  assert.deepEqual((await req(srv.url, 'GET', '/api/following')).body, []);
  assert.equal((await req(srv.url, 'PUT', '/api/following/0')).status, 400);

  const id = uid();
  fm.on(new RegExp(`artist/${id}$`), () => ({ id, name: 'Artist', picture_medium: 'p' }));
  fm.on(`deezer.test/artist/${id}/albums`, () => ({ data: [{ id: 1 }] })); // seedSeenAlbums
  const f = await req(srv.url, 'PUT', `/api/following/${id}`);
  assert.equal(f.body.following, true);
  assert.equal((await req(srv.url, 'GET', '/api/following')).body.length, 1);
  assert.ok(db.prepare('SELECT 1 FROM seen_artist_albums WHERE artist_id = ?').get(id));

  await req(srv.url, 'DELETE', `/api/following/${id}`);
  assert.equal((await req(srv.url, 'GET', '/api/following')).body.length, 0);
  assert.equal((await req(srv.url, 'DELETE', '/api/following/abc')).status, 400);

  const missing = uid();
  fm.on(new RegExp(`artist/${missing}$`), () => ({})); // no name -> 404
  assert.equal((await req(srv.url, 'PUT', `/api/following/${missing}`)).status, 404);
});

/* ----------------------------------------------------------- Home/explore */
test('home feed', async () => {
  // Error path first (successful responses get cached, so it must run before the
  // happy path or the cache would mask the failure).
  fm.on('deezer.test/chart/0/tracks', () => { throw new Error('x'); });
  assert.equal((await req(srv.url, 'GET', '/api/home')).status, 502);

  fm.reset(); fm.install();
  const chart = (key) => fm.on(`deezer.test/chart/0/${key}`, () => ({ data: [{ id: 1, title: 'X', name: 'X', artist: { name: 'A', id: 1 }, album: { title: 'Al', id: 2, cover_medium: 'c' }, cover_medium: 'c', picture_medium: 'p', nb_tracks: 1, user: { name: 'U' }, duration: 5, contributors: [] }] }));
  ['tracks', 'albums', 'artists', 'playlists'].forEach(chart);
  const home = await req(srv.url, 'GET', '/api/home');
  assert.equal(home.body.tracks.length, 1);
});

test('explore feed with mood cover art', async () => {
  fm.on(/\/genre$/, () => ({ data: [{ id: 0, name: 'All' }, { id: 5, name: 'Rock', picture_medium: 'p' }] }));
  fm.on('deezer.test/editorial/0/releases', () => ({ data: [{ id: 1, title: 'R', artist: { name: 'A' }, cover_medium: 'c' }] }));
  fm.on('deezer.test/chart/0/albums', () => ({ data: [{ id: 2, title: 'Al', artist: { name: 'A', id: 1 }, cover_medium: 'c' }] }));
  fm.on('deezer.test/chart/0/playlists', () => ({ data: [{ id: 3, title: 'P', picture_medium: 'p', nb_tracks: 1, user: { name: 'U' } }] }));
  fm.on('deezer.test/chart/0/artists', () => ({ data: [{ id: 4, name: 'A', picture_medium: 'p' }] }));
  fm.on('deezer.test/search/playlist', () => ({ data: [{ id: 2, title: 'P', picture_xl: 'x', nb_tracks: 1, user: { name: 'U' } }] }));
  const ex = await req(srv.url, 'GET', '/api/explore');
  assert.ok(ex.body.genres.find(g => g.name === 'Rock'));
  assert.equal(ex.body.moods.length, 20);
});

test('mood feed: known and unknown slugs', async () => {
  const mId = uid();
  fm.on('deezer.test/search/playlist', () => ({ data: [{ id: mId, title: 'Happy', picture_medium: 'p', nb_tracks: 1, user: { name: 'U' } }] }));
  fm.on(`deezer.test/playlist/${mId}`, () => ({ tracks: { data: [{ id: 11, title: 'S', artist: { name: 'A', id: 1 }, contributors: [], album: { title: 'Al', id: 2, cover_medium: 'c' }, duration: 5 }] } }));
  const mood = await req(srv.url, 'GET', '/api/mood/happy');
  assert.equal(mood.body.name, 'Happy');
  assert.ok(mood.body.tracks.length >= 1);
  assert.equal((await req(srv.url, 'GET', '/api/mood/whatever')).body.slug, 'whatever');
});

test('genre feed', async () => {
  const gId = 7;
  fm.on(`deezer.test/genre/${gId}`, () => ({ name: 'Rock' }));
  fm.on(`deezer.test/chart/${gId}`, () => ({ artists: { data: [{ id: 1, name: 'A', picture_medium: 'p' }] }, albums: { data: [{ id: 2, title: 'Al', artist: { name: 'A', id: 1 }, cover_medium: 'c' }] }, playlists: { data: [{ id: 3, title: 'P', picture_medium: 'p', nb_tracks: 1, user: { name: 'U' } }] }, tracks: { data: [{ id: 4, title: 'T', artist: { name: 'A', id: 1 }, album: { id: 2, cover_medium: 'c' }, contributors: [], duration: 5 }] } }));
  const genre = await req(srv.url, 'GET', `/api/genre/${gId}`);
  assert.equal(genre.body.name, 'Rock');
  assert.equal(genre.body.tracks.length, 1);
});

/* ----------------------------------------------------------- Downloads */
test('download validation, dedupe, album/track queueing, and errors', async () => {
  assert.equal((await req(srv.url, 'POST', '/api/download', { body: { kind: 'bad', deezer_id: 1 } })).status, 400);

  const onDisk = uid();
  const f = path.join(config.musicDir, 'have.flac'); fs.writeFileSync(f, 'a');
  addTrack({ deezer_id: onDisk, file_path: f });
  assert.equal((await req(srv.url, 'POST', '/api/download', { body: { kind: 'track', deezer_id: onDisk } })).body.alreadyHave, true);

  const alId = uid();
  fm.on(`deezer.test/album/${alId}`, () => ({ artist: { name: 'A' }, title: 'Al', cover_medium: 'c' }));
  const al = await req(srv.url, 'POST', '/api/download', { body: { kind: 'album', deezer_id: alId } });
  assert.ok(al.body.id);

  const trId = uid();
  fm.on(`deezer.test/track/${trId}`, () => ({ artist: { name: 'A' }, title: 'T', album: { cover_medium: 'c' } }));
  assert.ok((await req(srv.url, 'POST', '/api/download', { body: { kind: 'track', deezer_id: trId } })).body.id);

  const errId = uid();
  fm.on(`deezer.test/album/${errId}`, () => { throw new Error('boom'); });
  assert.equal((await req(srv.url, 'POST', '/api/download', { body: { kind: 'album', deezer_id: errId } })).status, 502);
});

test('downloads listing (admin vs user) and deletion', async () => {
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, engine) VALUES (?, 'track', 1, 'L', 'soulseek')`).run(user.id);
  asUser();
  const mine = await req(srv.url, 'GET', '/api/downloads');
  assert.equal(mine.body.length, 1);
  const id = mine.body[0].id;
  asAdmin();
  assert.ok((await req(srv.url, 'GET', '/api/downloads')).body.find(d => d.username === 'user'));
  await req(srv.url, 'DELETE', `/api/downloads/${id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n, 0);

  // A regular user can only delete their own.
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, engine) VALUES (?, 'track', 2, 'L', 'soulseek')`).run(admin.id);
  asUser();
  await req(srv.url, 'DELETE', `/api/downloads/${db.prepare('SELECT id FROM downloads').get().id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n, 1); // not theirs -> kept
});

/* ----------------------------------------------------------- Favorites */
test('favorites: ensureTrack upserts from body, toggle, and unknown rejection', async () => {
  asUser();
  const known = uid();
  addTrack({ deezer_id: known });
  await req(srv.url, 'PUT', `/api/favorites/${known}`);
  assert.equal((await req(srv.url, 'GET', '/api/favorites')).body.length, 1);

  const fresh = uid();
  await req(srv.url, 'PUT', `/api/favorites/${fresh}`, { body: { title: 'New', artist: 'Ar' } });
  assert.ok(db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(fresh));

  assert.equal((await req(srv.url, 'PUT', '/api/favorites/abc')).status, 400);            // NaN
  assert.equal((await req(srv.url, 'PUT', `/api/favorites/${uid()}`)).status, 400);        // unknown, no body

  await req(srv.url, 'DELETE', `/api/favorites/${known}`);
  assert.equal((await req(srv.url, 'GET', '/api/favorites')).body.length, 1);
});

/* ----------------------------------------------------------- Playlists */
test('playlists: create, get, share, edit, import, delete', async () => {
  asUser();
  assert.equal((await req(srv.url, 'POST', '/api/playlists', { body: {} })).status, 400);
  const pl = await req(srv.url, 'POST', '/api/playlists', { body: { name: 'Mine' } });
  const id = pl.body.id;
  const t1 = uid(); addTrack({ deezer_id: t1, cover: 'cov' });
  await req(srv.url, 'POST', `/api/playlists/${id}/tracks`, { body: { track_id: t1 } });

  const got = await req(srv.url, 'GET', `/api/playlists/${id}`);
  assert.equal(got.body.is_owner, true);
  assert.equal(got.body.tracks.length, 1);
  assert.equal((await req(srv.url, 'GET', '/api/playlists/99999')).status, 404);
  assert.ok((await req(srv.url, 'GET', '/api/playlists')).body.find(p => p.id === id));

  // Share with admin as viewer, then editor.
  await req(srv.url, 'POST', `/api/playlists/${id}/shares`, { body: { user_id: admin.id, can_edit: false } });
  assert.equal((await req(srv.url, 'POST', `/api/playlists/${id}/shares`, { body: { user_id: user.id } })).status, 400); // self
  assert.equal((await req(srv.url, 'POST', `/api/playlists/${id}/shares`, { body: { user_id: 99999 } })).status, 404);
  assert.equal((await req(srv.url, 'POST', `/api/playlists/${id}/shares`, { body: {} })).status, 400);
  assert.equal((await req(srv.url, 'GET', `/api/playlists/${id}/shares`)).body.length, 1);

  // Admin (viewer) cannot edit; promote to editor and retry.
  asAdmin();
  assert.equal((await req(srv.url, 'POST', `/api/playlists/${id}/tracks`, { body: { track_id: t1 } })).status, 403);
  assert.equal((await req(srv.url, 'GET', `/api/playlists/${id}/shares`)).status, 403); // not owner
  asUser();
  await req(srv.url, 'POST', `/api/playlists/${id}/shares`, { body: { user_id: admin.id, can_edit: true } });
  asAdmin();
  const t2 = uid(); addTrack({ deezer_id: t2 });
  assert.equal((await req(srv.url, 'POST', `/api/playlists/${id}/tracks`, { body: { track_id: t2 } })).body.ok, true);
  await req(srv.url, 'DELETE', `/api/playlists/${id}/tracks/${t2}`);
  // Owner removes a specific user's share.
  asUser();
  assert.equal((await req(srv.url, 'DELETE', `/api/playlists/${id}/shares/${admin.id}`)).body.ok, true);
  await req(srv.url, 'POST', `/api/playlists/${id}/shares`, { body: { user_id: admin.id, can_edit: true } }); // re-share for later asserts
  asAdmin();

  // Recipient "delete" removes only their share; owner delete removes the list.
  await req(srv.url, 'DELETE', `/api/playlists/${id}`); // admin removes share
  assert.ok(db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id));
  asUser();
  await req(srv.url, 'DELETE', `/api/playlists/${id}`);
  assert.ok(!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id));
  assert.equal((await req(srv.url, 'DELETE', '/api/playlists/99999')).body.ok, true);

  // Editing a non-existent playlist 404s; share management on it too.
  assert.equal((await req(srv.url, 'POST', '/api/playlists/99999/tracks', { body: { track_id: t1 } })).status, 404);
  assert.equal((await req(srv.url, 'DELETE', '/api/playlists/99999/shares/1')).status, 404);
});

test('playlist import from Deezer queues missing tracks', async () => {
  asUser();
  assert.equal((await req(srv.url, 'POST', '/api/playlists/import-deezer', { body: {} })).status, 400);
  const plId = uid();
  fm.on(`deezer.test/playlist/${plId}`, () => ({ title: 'Imported', tracks: { data: [
    { id: uid(), title: 'One', artist: { name: 'A', id: 1 }, album: { title: 'Al', id: 2, cover_medium: 'c' }, duration: 5 },
    { id: uid(), title: 'Two', artist: { name: 'A', id: 1 }, album: { title: 'Al', id: 2, cover_medium: 'c' }, duration: 5 },
  ] } }));
  const r = await req(srv.url, 'POST', '/api/playlists/import-deezer', { body: { deezer_playlist_id: plId } });
  assert.equal(r.body.total, 2);
  assert.equal(r.body.queued, 2);
  // Re-import reuses the same-named playlist.
  const again = await req(srv.url, 'POST', '/api/playlists/import-deezer', { body: { deezer_playlist_id: plId } });
  assert.equal(again.body.id, r.body.id);

  const emptyId = uid();
  fm.on(`deezer.test/playlist/${emptyId}`, () => ({ title: 'Empty', tracks: { data: [] } }));
  assert.equal((await req(srv.url, 'POST', '/api/playlists/import-deezer', { body: { deezer_playlist_id: emptyId } })).status, 400);
});

/* ------------------------------------------------- Plays / prefs / history */
test('plays (dedupe + unknown), history, and preferences', async () => {
  asUser();
  assert.equal((await req(srv.url, 'POST', '/api/plays', { body: {} })).status, 400);
  const t = uid(); addTrack({ deezer_id: t, file_path: '/p.flac' });
  await req(srv.url, 'POST', '/api/plays', { body: { track_id: t } });
  await req(srv.url, 'POST', '/api/plays', { body: { track_id: t } }); // de-duped within 30s
  await req(srv.url, 'POST', '/api/plays', { body: { track_id: 9999999 } }); // unknown -> ignored
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plays').get().n, 1);
  assert.equal((await req(srv.url, 'GET', '/api/history')).body.length, 1);

  assert.deepEqual((await req(srv.url, 'GET', '/api/preferences')).body, {});
  const saved = await req(srv.url, 'PUT', '/api/preferences', { body: { volume: 2, eqEnabled: true, eqGains: [1, 2], repeat: 'all', junk: 'x' } });
  assert.equal(saved.body.volume, 1);          // clamped
  assert.equal(saved.body.repeat, 'all');
  assert.equal(saved.body.junk, undefined);    // unknown dropped
  // Invalid values are ignored; existing prefs preserved on merge.
  const merged = await req(srv.url, 'PUT', '/api/preferences', { body: { volume: 'x', eqGains: ['a'], repeat: 'bad' } });
  assert.equal(merged.body.volume, 1);

  // Saved equalizer presets: valid ones kept, malformed entries dropped.
  const withPresets = await req(srv.url, 'PUT', '/api/preferences', { body: { eqPresets: {
    'My Bass': [6, 4, 2, 0, 0, 0],
    '  ': [1, 2, 3],                          // blank name -> dropped
    Bad: [1, 'x', 3],                          // non-numeric -> dropped
    Empty: [],                                 // no bands -> dropped
    TooMany: Array(13).fill(0),                // > 12 bands -> dropped
  } } });
  assert.deepEqual(Object.keys(withPresets.body.eqPresets), ['My Bass']);
  assert.deepEqual(withPresets.body.eqPresets['My Bass'], [6, 4, 2, 0, 0, 0]);
  // A non-object eqPresets is ignored entirely (existing prefs preserved).
  const ignored = await req(srv.url, 'PUT', '/api/preferences', { body: { eqPresets: [1, 2, 3] } });
  assert.deepEqual(Object.keys(ignored.body.eqPresets), ['My Bass']);
});

/* ----------------------------------------------------------- Stats */
test('stats: own, ranges, another user, and not found', async () => {
  asUser();
  const t = uid(); addTrack({ deezer_id: t, artist_id: 1, album_id: 2, file_path: '/s.flac', duration: 100 });
  db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(user.id, t);
  const own = await req(srv.url, 'GET', '/api/stats?range=month');
  assert.equal(own.body.range, 'month');
  assert.equal(own.body.totals.plays, 1);
  assert.equal((await req(srv.url, 'GET', '/api/stats?range=bogus')).body.range, 'all'); // invalid -> all

  const other = await req(srv.url, 'GET', `/api/stats?user=${admin.id}`);
  assert.equal(other.body.username, 'admin');
  assert.equal((await req(srv.url, 'GET', '/api/stats?user=999999')).status, 404);
});

/* ------------------------------------------------- Mixes / recs / radio */
test('mixes: smart playlists and best-effort daily discovery', async () => {
  asUser();
  for (let i = 0; i < 3; i++) {
    const t = uid(); addTrack({ deezer_id: t, artist_id: 100, file_path: `/m${i}.flac` });
    db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(user.id, t);
    db.prepare('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)').run(user.id, t);
  }
  fm.on('deezer.test/artist/100/top', () => ({ data: Array.from({ length: 6 }, (_, i) => ({ id: 200 + i, title: `S${i}`, artist: { name: 'A', id: 100 }, album: { id: 1, cover_medium: 'c' }, contributors: [], duration: 5 })) }));
  fm.on('deezer.test/artist/100/related', () => ({ data: [{ id: 101, name: 'Rel', picture_medium: 'p' }] }));
  fm.on('deezer.test/artist/101/top', () => ({ data: [{ id: 300, title: 'R', artist: { name: 'Rel', id: 101 }, album: { id: 1, cover_medium: 'c' }, contributors: [], duration: 5 }] }));
  const mixes = await req(srv.url, 'GET', '/api/mixes');
  assert.ok(mixes.body.smart.find(m => m.key === 'on-repeat'));
  assert.ok(mixes.body.smart.find(m => m.key === 'liked'));
  assert.ok(mixes.body.daily.length >= 1);
});

test('recommendations: personalized and chart fallback', async () => {
  asUser();
  const fresh = createUser({ username: 'newbie' });
  setUser({ id: fresh.id, username: 'newbie', is_admin: 0 });
  // Cold-path upstream failure first (before the success caches chart/0/tracks).
  fm.on('deezer.test/chart/0/tracks', () => { throw new Error('x'); });
  assert.equal((await req(srv.url, 'GET', '/api/recommendations')).status, 502);
  fm.reset(); fm.install();
  fm.on('deezer.test/chart/0/tracks', () => ({ data: [{ id: 1, title: 'C', artist: { name: 'A', id: 1 }, album: { id: 2, cover_medium: 'c' }, contributors: [], duration: 5 }] }));
  const cold = await req(srv.url, 'GET', '/api/recommendations');
  assert.equal(cold.body.personalized, false);

  setUser({ id: user.id, username: 'user', is_admin: 0 });
  const t = uid(); addTrack({ deezer_id: t, artist_id: 100, file_path: '/r.flac' });
  db.prepare('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)').run(user.id, t);
  fm.on('deezer.test/artist/100/related', () => ({ data: [{ id: 101, name: 'R', picture_medium: 'p' }] }));
  fm.on('deezer.test/artist/101/top', () => ({ data: [{ id: 5, title: 'X', artist: { name: 'R', id: 101 }, album: { id: 2, cover_medium: 'c' }, contributors: [], duration: 5 }] }));
  const warm = await req(srv.url, 'GET', '/api/recommendations');
  assert.equal(warm.body.personalized, true);
  assert.ok(warm.body.tracks.length >= 1);
});

test('radio: seed validation, track seed, artist seed', async () => {
  asUser();
  assert.equal((await req(srv.url, 'GET', '/api/radio?seed=garbage')).status, 400);
  fm.on('deezer.test/track/55', () => ({ id: 55, title: 'Seed', artist: { id: 100, name: 'A' }, album: { id: 1, cover_medium: 'c' }, contributors: [] }));
  fm.on('deezer.test/artist/100/radio', () => ({ data: [{ id: 55, title: 'Seed' }, { id: 56, title: 'Next', artist: { id: 100, name: 'A' }, album: { id: 1, cover_medium: 'c' }, contributors: [], duration: 5 }] }));
  const r = await req(srv.url, 'GET', '/api/radio?seed=track:55');
  assert.ok(r.body.tracks.length >= 2);
  const a = await req(srv.url, 'GET', '/api/radio?seed=artist:100');
  assert.ok(a.body.tracks.length >= 1);
});

test('track-status batch lookup', async () => {
  asUser();
  const t = uid(); addTrack({ deezer_id: t, album_id: 77, file_path: '/t.flac' });
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine) VALUES (?, 'track', ?, 'L', 'downloading', 'soulseek')`).run(user.id, t);
  assert.deepEqual((await req(srv.url, 'GET', '/api/track-status')).body, {});
  const r = await req(srv.url, 'GET', `/api/track-status?ids=${t},abc`);
  assert.equal(r.body[t].available, true);
  assert.equal(r.body[t].status, 'downloading');
});

/* ------------------------------------------------- Library mgmt / avatars */
test('promote to library, admin delete, and avatars + streaming', async () => {
  const t = uid();
  const f = path.join(config.musicDir, 'stream.flac');
  fs.writeFileSync(f, Buffer.alloc(2048, 7));
  addTrack({ deezer_id: t, file_path: f });
  db.prepare('UPDATE tracks SET in_library = 0 WHERE deezer_id = ?').run(t);

  assert.equal((await req(srv.url, 'PUT', '/api/library/abc')).status, 400);
  assert.equal((await req(srv.url, 'PUT', `/api/library/${uid()}`)).status, 404);
  const notOnDisk = uid(); addTrack({ deezer_id: notOnDisk });
  assert.equal((await req(srv.url, 'PUT', `/api/library/${notOnDisk}`)).status, 400);
  assert.equal((await req(srv.url, 'PUT', `/api/library/${t}`)).body.ok, true);

  // Streaming: full, range, HEAD, unsatisfiable range, and not-in-library.
  const full = await req(srv.url, 'GET', `/api/stream/${t}`);
  assert.equal(full.status, 200);
  const range = await req(srv.url, 'GET', `/api/stream/${t}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await req(srv.url, 'GET', `/api/stream/${t}`, { headers: { range: 'bytes=99999-' } })).status, 416);
  assert.equal((await req(srv.url, 'GET', `/api/stream/${uid()}`)).status, 404);

  // Avatars.
  assert.equal((await req(srv.url, 'GET', `/api/avatar/${user.id}`)).status, 404);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10)]).toString('base64');
  assert.equal((await req(srv.url, 'POST', '/api/avatar', { body: { image: jpeg } })).body.ok, true);
  assert.equal((await req(srv.url, 'GET', `/api/avatar/${admin.id}`)).status, 200);
  assert.equal((await req(srv.url, 'POST', '/api/avatar', { body: { image: 'data:text/plain;base64,AAAA' } })).status, 400);
  assert.equal((await req(srv.url, 'POST', '/api/avatar', { body: { image: 'data:image/jpeg;base64,ABC@' } })).status, 400);
  const notJpeg = 'data:image/jpeg;base64,' + Buffer.from([1, 2, 3, 4]).toString('base64');
  assert.equal((await req(srv.url, 'POST', '/api/avatar', { body: { image: notJpeg } })).status, 400);
  await req(srv.url, 'DELETE', '/api/avatar');

  // Admin-only file delete.
  asUser();
  assert.equal((await req(srv.url, 'DELETE', `/api/library/${t}`)).status, 403);
  asAdmin();
  assert.equal((await req(srv.url, 'DELETE', '/api/library/abc')).status, 400);
  assert.equal((await req(srv.url, 'DELETE', `/api/library/${uid()}`)).status, 404);
  assert.equal((await req(srv.url, 'DELETE', `/api/library/${t}`)).body.removed >= 1, true);
});

test('upstream failures surface as 502 for each Deezer-backed endpoint', async () => {
  asUser();
  // Fresh ids -> empty cache -> the throwing route is actually hit.
  const cases = [
    (id) => { fm.on(new RegExp(`artist/${id}$`), () => { throw new Error('x'); }); return ['PUT', `/api/following/${id}`]; },
    (id) => { fm.on(`deezer.test/album/${id}`, () => { throw new Error('x'); }); return ['GET', `/api/album/${id}`]; },
    (id) => { fm.on(`deezer.test/playlist/${id}`, () => { throw new Error('x'); }); return ['GET', `/api/deezer-playlist/${id}`]; },
    (id) => { fm.on(`deezer.test/playlist/${id}`, () => { throw new Error('x'); }); return ['POST', '/api/playlists/import-deezer', { deezer_playlist_id: id }]; },
    (id) => { fm.on(`deezer.test/track/${id}`, () => { throw new Error('x'); }); return ['GET', `/api/radio?seed=track:${id}`]; },
    (id) => { fm.on(`deezer.test/track/${id}`, () => { throw new Error('x'); }); return ['GET', `/api/preview/${id}`]; },
  ];
  for (const make of cases) {
    const id = uid();
    const [method, p, body] = make(id);
    assert.equal((await req(srv.url, method, p, { body })).status, 502, `${method} ${p}`);
  }
});

test('mood and genre upstream failures surface as 502', async () => {
  asUser();
  // 'jazz' (q="jazz lounge") isn't cached by the mood success test (which used 'happy').
  fm.on('deezer.test/search/playlist', () => { throw new Error('x'); });
  assert.equal((await req(srv.url, 'GET', '/api/mood/jazz')).status, 502);
  fm.reset(); fm.install();
  fm.on(/\/chart\/77$/, () => { throw new Error('x'); }); // fresh genre id -> empty cache
  assert.equal((await req(srv.url, 'GET', '/api/genre/77')).status, 502);
});

/* ----------------------------------------------------------- Preview / lyrics */
test('preview proxies Deezer audio; lyrics from LRCLIB with caching', async () => {
  asUser();
  assert.equal((await req(srv.url, 'GET', '/api/preview/abc')).status, 400);
  const t = uid();
  fm.on(`deezer.test/track/${t}`, () => ({ preview: 'https://cdn.deezer.test/p.mp3' }));
  fm.on('cdn.deezer.test/p.mp3', () => new Response(Buffer.alloc(16), { status: 200 }));
  assert.equal((await req(srv.url, 'GET', `/api/preview/${t}`)).status, 200);

  const noPrev = uid();
  fm.on(`deezer.test/track/${noPrev}`, () => ({}));
  assert.equal((await req(srv.url, 'GET', `/api/preview/${noPrev}`)).status, 404);

  const t2 = uid(); addTrack({ deezer_id: t2, title: 'Song', artist: 'Singer', album: 'Alb', duration: 100 });
  fm.on('lrclib.test/api/get', () => ({ syncedLyrics: '[00:01.00]Hello\n[00:02.50]World', plainLyrics: 'Hello\nWorld' }));
  const lyr = await req(srv.url, 'GET', `/api/lyrics/${t2}`);
  assert.equal(lyr.body.synced.length, 2);
  assert.equal(lyr.body.synced[0].text, 'Hello');
  await req(srv.url, 'GET', `/api/lyrics/${t2}`); // cached path

  assert.equal((await req(srv.url, 'GET', '/api/lyrics/abc')).status, 400);

  // Fresh routing table so the 404 lyrics handler isn't shadowed by the synced one.
  fm.reset(); fm.install();
  const t3 = uid();
  fm.on(`deezer.test/track/${t3}`, () => ({ title: 'X', artist: { name: 'Y' }, album: { title: 'Z' }, duration: 50 }));
  fm.on('lrclib.test/api/get', () => new Response('', { status: 404 }));
  fm.on('lrclib.test/api/search', () => ([]));
  assert.equal((await req(srv.url, 'GET', `/api/lyrics/${t3}`)).status, 404);

  // A track unknown to both the catalog and Deezer surfaces as 502.
  const t4 = uid();
  fm.on(`deezer.test/track/${t4}`, () => { throw new Error('x'); });
  assert.equal((await req(srv.url, 'GET', `/api/lyrics/${t4}`)).status, 502);

  // Search fallback: /api/get has no lyrics, /api/search yields a synced hit.
  fm.reset(); fm.install();
  const t5 = uid(); addTrack({ deezer_id: t5, title: 'Fb', artist: 'Ar', album: 'Al', duration: 80 });
  fm.on('lrclib.test/api/get', () => ({}));
  fm.on('lrclib.test/api/search', () => ([{ syncedLyrics: '[00:00.00]Hi', plainLyrics: 'Hi' }]));
  assert.equal((await req(srv.url, 'GET', `/api/lyrics/${t5}`)).body.synced.length, 1);
});
