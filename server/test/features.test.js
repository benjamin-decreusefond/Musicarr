// Tests for the bug-fix + feature batch: isrc persistence, to_library,
// filename-collision-safe imports, multi-disc matching, Deezer playlist
// pagination, playlist rename/reorder, the SSE hub, and the library import
// scanner.
import './helpers/env.js';
import { test, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, setSetting, db, upsertTrack, trackRowFromDeezer } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { makeAuthedApp, listen, req, setUser } from './helpers/app.js';
import { createUser, addTrack, wipe } from './helpers/seed.js';
import { deezerPlaylistTracks } from '../sources.js';
import { queueDownload, resumeOnBoot, startPoller } from '../downloader.js';
import { sseHandler, publish } from '../events.js';
import { startImportScan, scanState } from '../scanner.js';
import { stubTimers } from './helpers/timers.js';
import { writeWav } from './helpers/wav.js';

let srv, admin, user;
let UID = 90000;
const uid = () => UID++;
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));

before(async () => { srv = await listen(makeAuthedApp()); });
after(async () => { await srv.close(); });
beforeEach(() => {
  wipe();
  fm.install();
  config.maxConcurrentDownloads = 0; // queueDownload only writes its row
  setSetting('slskd_url', 'https://slskd.test');
  setSetting('slskd_api_key', 'k');
  admin = createUser({ username: 'admin', is_admin: 1 });
  user = createUser({ username: 'user' });
  setUser({ id: user.id, username: 'user', is_admin: 0 });
  for (const d of [config.slskdDownloadDir, config.musicDir]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
});
afterEach(() => { fm.uninstall(); });

/* ------------------------------------------------------------ isrc upsert */
test('upsertTrack persists isrc and keeps it when a later upsert omits it', () => {
  const id = uid();
  upsertTrack(trackRowFromDeezer({ id, title: 'T', artist: { name: 'A', id: 1 }, duration: 100, isrc: 'USABC1234567' }));
  assert.equal(db.prepare('SELECT isrc FROM tracks WHERE deezer_id = ?').get(id).isrc, 'USABC1234567');
  // Album-flavoured refresh (no isrc on Deezer's album tracklist) must not wipe it.
  upsertTrack(trackRowFromDeezer({ id, title: 'T', artist: { name: 'A', id: 1 }, duration: 100 }, { title: 'Al', id: 2 }));
  assert.equal(db.prepare('SELECT isrc FROM tracks WHERE deezer_id = ?').get(id).isrc, 'USABC1234567');
  // Callers that never heard of isrc (e.g. ensureTrack-style rows) still work.
  upsertTrack({ deezer_id: uid(), title: 'X', artist: 'A', artist_id: null, album: null, album_id: null, track_position: null, duration: null, cover: null });
});

/* ------------------------------------------------------------- to_library */
test('queueDownload records the to_library flag', () => {
  const onDisk = path.join(config.musicDir, 'have.wav'); writeWav(onDisk, 1);
  const t = uid();
  addTrack({ deezer_id: t, file_path: onDisk });
  const doneId = queueDownload(user.id, 'track', t, 'L', null, { toLibrary: false });
  assert.equal(db.prepare('SELECT to_library FROM downloads WHERE id = ?').get(doneId).to_library, 0);
  const freshId = queueDownload(user.id, 'track', uid(), 'L2', null);
  assert.equal(db.prepare('SELECT to_library FROM downloads WHERE id = ?').get(freshId).to_library, 1);
});

/* --------------------------------------------- import: collision + to_library */
// Drive a real import through the poll tick (same pattern as downloader.test).
async function activeDownload(kind, deezerId, deezerMock, remoteFiles, extra = {}) {
  fm.on(`deezer.test/${kind}/${deezerId}`, () => deezerMock);
  const info = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file, progress, to_library) VALUES (?, ?, ?, 'L', 'downloading', 'soulseek', 'peer', ?, 0, ?)`)
    .run(user.id, kind, deezerId, JSON.stringify(remoteFiles), extra.toLibrary === false ? 0 : 1);
  resumeOnBoot();
  await settle();
  return Number(info.lastInsertRowid);
}
async function completeAndTick(remoteFiles) {
  fm.reset(); fm.install();
  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: remoteFiles.map((f, i) => ({ id: i, filename: f, state: 'Completed, Succeeded', percentComplete: 100, size: 100 })) }] }));
  const t = stubTimers();
  startPoller();
  const tick = t.calls.intervals[0];
  t.restore();
  await tick();
  await settle();
}

test('import: two tracks with the same title get distinct filenames (no clobber)', async () => {
  const album = { id: 400, title: 'Al', artist: { name: 'A', id: 1 }, tracks: { data: [
    { id: 4001, title: 'Same', artist: { name: 'A', id: 1 }, track_position: 1, duration: 2 },
    { id: 4002, title: 'Same', artist: { name: 'A', id: 1 }, track_position: 2, duration: 3 },
  ] } };
  const remote = ['A/Al/01 Same.wav', 'A/Al/02 Same.wav'];
  const id = await activeDownload('album', 400, album, remote);
  const dir = path.join(config.slskdDownloadDir, 'Al'); fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, '01 Same.wav'), 2);
  writeWav(path.join(dir, '02 Same.wav'), 3);
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
  const p1 = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 4001').get().file_path;
  const p2 = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 4002').get().file_path;
  assert.ok(p1 && p2 && p1 !== p2, `expected two distinct files, got ${p1} / ${p2}`);
  assert.ok(fs.existsSync(p1) && fs.existsSync(p2));
});

test('import: multi-disc albums match by disc, not just track number', async () => {
  // Both discs have a "track 1" of the same length; only the disc prefix in the
  // filename can tell them apart. Deezer lists disc 2 first, so without the
  // disc gate its track would grab the disc-1 file.
  const album = { id: 420, title: 'Dbl', artist: { name: 'A', id: 1 }, tracks: { data: [
    { id: 4202, title: 'Beta', artist: { name: 'A', id: 1 }, track_position: 1, disk_number: 2, duration: 2 },
    { id: 4201, title: 'Alpha', artist: { name: 'A', id: 1 }, track_position: 1, disk_number: 1, duration: 2 },
  ] } };
  const remote = ['A/Dbl/1-01 aaa.wav', 'A/Dbl/2-01 bbb.wav'];
  const id = await activeDownload('album', 420, album, remote);
  const dir = path.join(config.slskdDownloadDir, 'Dbl'); fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, '1-01 aaa.wav'), 2);
  writeWav(path.join(dir, '2-01 bbb.wav'), 2);
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
  assert.match(db.prepare('SELECT source_path FROM tracks WHERE deezer_id = 4202').get().source_path, /bbb\.wav$/);
  assert.match(db.prepare('SELECT source_path FROM tracks WHERE deezer_id = 4201').get().source_path, /aaa\.wav$/);
});

test('import: a playlist download (to_library=0) does not promote into the Library', async () => {
  const tid = 410;
  const track = { id: tid, title: 'Quiet', artist: { name: 'A', id: 1 }, album: { id: 2, title: 'Al' }, duration: 2 };
  const remote = ['peer/Quiet.wav'];
  const id = await activeDownload('track', tid, track, remote, { toLibrary: false });
  writeWav(path.join(config.slskdDownloadDir, 'Quiet.wav'), 2);
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
  const row = db.prepare('SELECT file_path, in_library FROM tracks WHERE deezer_id = ?').get(tid);
  assert.ok(row.file_path, 'file imported');
  assert.equal(row.in_library, 0, 'playlist import must not flood the Library view');
});

/* ------------------------------------------------- Deezer playlist pagination */
test('deezerPlaylistTracks follows the pagination cursor', async () => {
  const plId = uid();
  fm.on(`deezer.test/playlist/${plId}/tracks`, (url) => {
    // Second page, no further cursor.
    assert.match(url, /index=2/);
    return { data: [{ id: 3, title: 'Three' }, { id: 4, title: 'Four' }] };
  });
  fm.on(`deezer.test/playlist/${plId}`, () => ({
    id: plId, title: 'Big',
    tracks: { data: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }],
      next: `https://api.deezer.com/playlist/${plId}/tracks?index=2` },
  }));
  const { playlist, tracks } = await deezerPlaylistTracks(plId);
  assert.equal(playlist.title, 'Big');
  assert.deepEqual(tracks.map(t => t.id), [1, 2, 3, 4]);
});

/* ------------------------------------------------ playlist rename + reorder */
test('playlists: owner can rename; reorder validates the permutation', async () => {
  const pl = await req(srv.url, 'POST', '/api/playlists', { body: { name: 'Old' } });
  const id = pl.body.id;
  const a = uid(), b = uid(), c = uid();
  for (const t of [a, b, c]) {
    addTrack({ deezer_id: t });
    await req(srv.url, 'POST', `/api/playlists/${id}/tracks`, { body: { track_id: t } });
  }

  // Rename: validation, then success; a non-owner gets 403.
  assert.equal((await req(srv.url, 'PUT', `/api/playlists/${id}`, { body: { name: '' } })).status, 400);
  assert.equal((await req(srv.url, 'PUT', `/api/playlists/${id}`, { body: { name: 'New name' } })).body.name, 'New name');
  assert.equal(db.prepare('SELECT name FROM playlists WHERE id = ?').get(id).name, 'New name');
  setUser({ id: admin.id, username: 'admin', is_admin: 1 });
  assert.equal((await req(srv.url, 'PUT', `/api/playlists/${id}`, { body: { name: 'Nope' } })).status, 403);
  setUser({ id: user.id, username: 'user', is_admin: 0 });

  // Reorder to c, a, b.
  const r = await req(srv.url, 'PUT', `/api/playlists/${id}/reorder`, { body: { track_ids: [c, a, b] } });
  assert.equal(r.status, 200);
  const got = await req(srv.url, 'GET', `/api/playlists/${id}`);
  assert.deepEqual(got.body.tracks.map(t => t.deezer_id), [c, a, b]);

  // Not a permutation (missing/extra ids) -> 409; garbage -> 400; unknown -> 404.
  assert.equal((await req(srv.url, 'PUT', `/api/playlists/${id}/reorder`, { body: { track_ids: [a, b] } })).status, 409);
  assert.equal((await req(srv.url, 'PUT', `/api/playlists/${id}/reorder`, { body: { track_ids: ['x'] } })).status, 400);
  assert.equal((await req(srv.url, 'PUT', '/api/playlists/99999/reorder', { body: { track_ids: [1] } })).status, 404);
});

/* ------------------------------------------------------------------ SSE hub */
test('SSE hub targets events per user, admin and member set', () => {
  const mkClient = (u) => {
    const res = { headers: null, chunks: [], writeHead(_c, h) { this.headers = h; }, write(s) { this.chunks.push(s); } };
    const req2 = { user: u, on(ev, cb) { if (ev === 'close') this.closeCb = cb; } };
    sseHandler(req2, res);
    return { res, req: req2 };
  };
  const alice = mkClient({ id: 1, is_admin: 0 });
  const bob = mkClient({ id: 2, is_admin: 0 });
  const boss = mkClient({ id: 3, is_admin: 1 });
  assert.equal(alice.res.headers['Content-Type'], 'text/event-stream');

  publish('download', { id: 7 }, { userId: 1, adminAlso: true });
  assert.ok(alice.res.chunks.some(c => c.includes('event: download')));
  assert.ok(!bob.res.chunks.some(c => c.includes('event: download')));
  assert.ok(boss.res.chunks.some(c => c.includes('event: download')));

  publish('listen', { id: 9 }, { userIds: [2] });
  assert.ok(bob.res.chunks.some(c => c.includes('event: listen')));
  assert.ok(!alice.res.chunks.some(c => c.includes('event: listen')));

  publish('scan', { running: true }, { adminOnly: true });
  assert.ok(boss.res.chunks.some(c => c.includes('event: scan')));
  assert.ok(!bob.res.chunks.some(c => c.includes('event: scan')));

  // Cleanup: close every client so the ping intervals are cleared.
  for (const c of [alice, bob, boss]) c.req.closeCb();
  publish('download', { id: 8 }); // no clients left: must not throw
});

test('GET /api/events streams events to the signed-in user', async () => {
  const ac = new AbortController();
  const { realFetch } = await import('./helpers/env.js');
  const res = await realFetch(`${srv.url}/api/events`, { signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const first = await reader.read(); // retry preamble
  assert.match(new TextDecoder().decode(first.value), /retry:/);
  publish('download', { id: 1 }, { userId: user.id });
  const second = await reader.read();
  assert.match(new TextDecoder().decode(second.value), /event: download/);
  ac.abort();
});

/* -------------------------------------------------------- library import scan */
test('import scan matches on-disk files to Deezer and links them in place', async () => {
  // An untagged file in Artist/Album layout; identification falls back to the path.
  const dir = path.join(config.musicDir, 'The Band', 'Great Album');
  fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, '01 - Hit Song.wav'), 2);
  // A file that matches nothing stays untouched.
  writeWav(path.join(config.musicDir, 'mystery.wav'), 2);

  const hitId = uid();
  fm.on('deezer.test/search/track', (url) => {
    if (decodeURIComponent(url).includes('Hit Song')) {
      return { data: [{ id: hitId, title: 'Hit Song', artist: { name: 'The Band', id: 5 }, album: { title: 'Great Album', id: 6, cover_medium: 'c' }, duration: 2 }] };
    }
    return { data: [] };
  });

  startImportScan();
  assert.throws(() => startImportScan(), /already running/);
  const deadline = Date.now() + 8000;
  while (scanState.running && Date.now() < deadline) await settle(50);

  assert.equal(scanState.running, false);
  assert.equal(scanState.imported, 1);
  assert.equal(scanState.skipped, 1);
  const row = db.prepare('SELECT file_path, in_library FROM tracks WHERE deezer_id = ?').get(hitId);
  assert.equal(row.file_path, path.join(dir, '01 - Hit Song.wav'));
  assert.equal(row.in_library, 1);
  assert.ok(fs.existsSync(path.join(config.musicDir, 'mystery.wav')), 'unmatched file left untouched');

  // The admin endpoints report/guard the scan.
  setUser({ id: admin.id, username: 'admin', is_admin: 1 });
  const st = await req(srv.url, 'GET', '/api/library/scan');
  assert.equal(st.body.imported, 1);
  setUser({ id: user.id, username: 'user', is_admin: 0 });
  assert.equal((await req(srv.url, 'GET', '/api/library/scan')).status, 403);
  assert.equal((await req(srv.url, 'POST', '/api/library/scan')).status, 403);
});
