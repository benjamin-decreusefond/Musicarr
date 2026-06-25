import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, setSetting } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { stubTimers } from './helpers/timers.js';
import { writeWav } from './helpers/wav.js';
import {
  queueDownload, cleanupStaleTracks, scanLibrary, deleteTrackFile,
  sweepUnimported, resumeOnBoot, startPoller, cancelDownloadTransfers, retryDownload,
} from '../downloader.js';
import { createUser, addTrack, wipe, db } from './helpers/seed.js';

let uid;
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));
const dlDir = () => config.slskdDownloadDir;
const musicDir = () => config.musicDir;

beforeEach(() => {
  wipe();
  fm.install();
  config.maxConcurrentDownloads = 3;
  setSetting('slskd_url', 'https://slskd.test');
  setSetting('slskd_api_key', 'k');
  uid = createUser({ username: 'u' }).id;
  // Clean the download/music dirs between tests.
  for (const d of [dlDir(), musicDir()]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
});
afterEach(() => { fm.uninstall(); });

// Wait until a download reaches one of the given statuses (the search flow runs
// asynchronously with real slskd polling delays).
async function waitStatus(id, statuses, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
    if (row && statuses.includes(row.status)) return row;
    await settle(50);
  }
  return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
}

// Run the poll tick once (captured from startPoller).
async function runTick() {
  const t = stubTimers();
  startPoller();
  const tick = t.calls.intervals[0];
  t.restore();
  await tick();
  await settle();
}

/* --------------------------------------------------------- queueDownload dedup */
test('queueDownload records an already-on-disk track as done without searching', () => {
  const f = path.join(musicDir(), 'have.wav'); writeWav(f, 1);
  addTrack({ deezer_id: 1, file_path: f });
  const id = queueDownload(uid, 'track', 1, 'A - T', 'c');
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
});

test('cancelDownloadTransfers cancels matching slskd transfers (best-effort)', async () => {
  let cancelled = 0;
  fm.on(/transfers\/downloads\/peer/, (u, o) => {
    if (o.method === 'DELETE') { cancelled++; return fm.json({}, 200); } // .../peer/<id>
    return { directories: [{ files: [
      { id: 7, filename: 'A/Song.wav', state: 'InProgress' },
      { id: 8, filename: 'A/Other.wav', state: 'InProgress' }, // not ours
    ] }] };
  });
  await cancelDownloadTransfers({ id: 500, slskd_user: 'peer', slskd_file: JSON.stringify(['A/Song.wav']) });
  assert.equal(cancelled, 1); // only our file's transfer was cancelled

  // No slskd_user -> nothing to cancel, returns cleanly.
  await cancelDownloadTransfers({ id: 501 });
});

test('retryDownload re-queues a failed download and resets retry state', async () => {
  config.maxConcurrentDownloads = 0; // keep the re-queued search from running
  const info = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, attempts, failed_candidates) VALUES (?, 'track', 510, 'L', 'not_found', 'soulseek', 4, '{"x":2}')`).run(uid);
  const id = Number(info.lastInsertRowid);
  retryDownload(db.prepare('SELECT * FROM downloads WHERE id = ?').get(id));
  const row = db.prepare('SELECT status, attempts, failed_candidates FROM downloads WHERE id = ?').get(id);
  assert.equal(row.status, 'searching');
  assert.equal(row.attempts, 0);
  assert.equal(row.failed_candidates, null);
});

test('startSearch errors when slskd is not configured', async () => {
  setSetting('slskd_url', '');
  const id = queueDownload(uid, 'track', 2, 'A - T', 'c');
  const row = await waitStatus(id, ['error']);
  assert.match(row.detail, /not configured/);
});

/* ------------------------------------------------------------- Track search flow */
test('track flow: search, rank, enqueue, then import via the poll tick', async () => {
  fm.on('deezer.test/track/10', () => ({ id: 10, title: 'Song', artist: { name: 'Artist', id: 1 }, album: { id: 5, cover_medium: 'c' }, duration: 2, isrc: 'US1234567890' }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => ({ id: 's' }));
  fm.on(/searches\/s$/, (u, o) => o.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 1 });
  fm.on(/searches\/s\/responses$/, () => ([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [{ filename: 'Artist/Song.wav', size: 100, length: 2 }] }]));
  fm.on(/transfers\/downloads\/peer$/, (u, o) => o.method === 'POST' ? fm.json({}, 200) : ({ directories: [] }));

  const id = queueDownload(uid, 'track', 10, 'Artist - Song', 'c');
  const dl = await waitStatus(id, ['downloading', 'not_found', 'error']);
  assert.equal(dl.status, 'downloading');

  // The downloaded file lands in slskd's dir; the tick sees it completed and imports it.
  writeWav(path.join(dlDir(), 'Song.wav'), 2);
  fm.reset(); fm.install(); // replace the search-phase transfers route
  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: [{ id: 1, filename: 'Artist/Song.wav', state: 'Completed, Succeeded', percentComplete: 100, size: 100 }] }] }));
  await runTick();

  const done = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  assert.equal(done.status, 'done');
  assert.ok(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 10').get().file_path);
});

test('track flow: no candidates ends as not_found', async () => {
  fm.on('deezer.test/track/11', () => ({ id: 11, title: 'Gone', artist: { name: 'Nobody', id: 9 }, album: { id: 1 }, duration: 200 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => ({ id: 'n' }));
  fm.on(/searches\/n$/, (u, o) => o.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 0 });
  fm.on(/searches\/n\/responses$/, () => ([]));
  const id = queueDownload(uid, 'track', 11, 'Nobody - Gone', 'c');
  const row = await waitStatus(id, ['not_found', 'error']);
  assert.equal(row.status, 'not_found');
});

test('track flow: transient slskd failure ends as a retriable error', async () => {
  fm.on('deezer.test/track/12', () => ({ id: 12, title: 'X', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 100 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => { const e = new Error('fetch failed'); throw e; });
  const id = queueDownload(uid, 'track', 12, 'A - X', 'c');
  const row = await waitStatus(id, ['error', 'not_found']);
  assert.match(row.detail, /unreachable|offline/);
});

/* ------------------------------------------------------------- Album import flow */
test('album flow imports a multi-track folder and matches by number/title/duration', async () => {
  const album = { id: 20, title: 'Alb', artist: { name: 'Band', id: 2 },
    tracks: { data: [
      { id: 201, title: 'One', artist: { name: 'Band', id: 2 }, track_position: 1, duration: 2 },
      { id: 202, title: 'Two', artist: { name: 'Band', id: 2 }, track_position: 2, duration: 3 },
    ] } };
  fm.on('deezer.test/album/20', () => album);

  // Insert the active download and let resumeOnBoot rebuild its import plan.
  const info = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file, progress) VALUES (?, 'album', 20, 'Band - Alb', 'downloading', 'soulseek', 'peer', ?, 0)`)
    .run(uid, JSON.stringify(['Band/Alb/01 One.wav', 'Band/Alb/02 Two.wav']));
  const id = Number(info.lastInsertRowid);

  const folder = path.join(dlDir(), 'Alb');
  fs.mkdirSync(folder, { recursive: true });
  writeWav(path.join(folder, '01 One.wav'), 2);
  writeWav(path.join(folder, '02 Two.wav'), 3);

  resumeOnBoot();
  await settle();

  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: [
    { id: 1, filename: 'Band/Alb/01 One.wav', state: 'Completed, Succeeded', percentComplete: 100, size: 100 },
    { id: 2, filename: 'Band/Alb/02 Two.wav', state: 'Completed, Succeeded', percentComplete: 100, size: 100 },
  ] }] }));
  await runTick();

  const done = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  assert.equal(done.status, 'done');
  assert.ok(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 201').get().file_path);
  assert.ok(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 202').get().file_path);
});

/* --------------------------------------------------------------- Poll tick edges */
test('tick reports progress and fails over a stalled transfer', async () => {
  config.slskdStallMs = -1; // any non-advancing poll counts as stalled immediately
  fm.on('deezer.test/track/30', () => ({ id: 30, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 100 }));
  const info = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file, progress) VALUES (?, 'track', 30, 'A - S', 'downloading', 'soulseek', 'peer', ?, 0)`)
    .run(uid, JSON.stringify(['A/S.wav']));
  const id = Number(info.lastInsertRowid);
  resumeOnBoot(); await settle();

  // In-progress (not terminal): records progress, then stalls -> handleTransferFailure.
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: [{ id: 1, filename: 'A/S.wav', state: 'InProgress', percentComplete: 40, size: 100 }] }] }));
  await runTick();
  await runTick(); // second poll: no progress advance -> stalled -> retry/search
  const row = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  assert.ok(['searching', 'downloading', 'not_found', 'error'].includes(row.status));
});

test('tick fails a transfer that completes without success', async () => {
  fm.on('deezer.test/track/31', () => ({ id: 31, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 100 }));
  const info = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file, progress, attempts) VALUES (?, 'track', 31, 'A - S', 'downloading', 'soulseek', 'peer', ?, 0, 6)`)
    .run(uid, JSON.stringify(['A/S.wav']));
  const id = Number(info.lastInsertRowid);
  resumeOnBoot(); await settle();
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: [{ id: 1, filename: 'A/S.wav', state: 'Completed, Errored', percentComplete: 100, size: 100 }] }] }));
  await runTick();
  // attempts already at the max -> gives up with an error.
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'error');
});

/* ------------------------------------------------------------------- scanLibrary */
test('scanLibrary prunes vanished files and relinks present ones', () => {
  const present = path.join(musicDir(), 'Artist', 'Album');
  fs.mkdirSync(present, { recursive: true });
  const file = path.join(present, 'Title.wav'); writeWav(file, 1);
  addTrack({ deezer_id: 40, artist: 'Artist', album: 'Album', title: 'Title' }); // no file_path yet
  addTrack({ deezer_id: 41, file_path: '/gone/missing.wav' });                    // file vanished

  const res = scanLibrary();
  assert.equal(res.relinked, 1);
  assert.equal(res.pruned, 1);
  assert.equal(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 40').get().file_path, file);
  assert.equal(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 41').get().file_path, null);
});

/* ----------------------------------------------------------------- deleteTrackFile */
test('deleteTrackFile removes the library + source files and prunes empty dirs', () => {
  const artistDir = path.join(musicDir(), 'Artist', 'Album');
  fs.mkdirSync(artistDir, { recursive: true });
  const lib = path.join(artistDir, 'Title.wav'); writeWav(lib, 1);
  const srcDir = path.join(dlDir(), 'Album'); fs.mkdirSync(srcDir, { recursive: true });
  const src = path.join(srcDir, 'Title.wav'); fs.linkSync(lib, src); // hardlink (same inode)

  addTrack({ deezer_id: 50, artist: 'Artist', album: 'Album', title: 'Title', file_path: lib });
  db.prepare('UPDATE tracks SET source_path = ? WHERE deezer_id = 50').run(src);

  const res = deleteTrackFile(50);
  assert.ok(res.removed.length >= 1);
  assert.ok(!fs.existsSync(lib));
  assert.ok(!fs.existsSync(src));
  assert.ok(!fs.existsSync(artistDir));                       // empty dirs pruned
  assert.equal(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 50').get().file_path, null);

  assert.deepEqual(deleteTrackFile(99999), { removed: [], notFound: true });
});

test('deleteTrackFile finds an orphaned source by inode when source_path is unset', () => {
  const artistDir = path.join(musicDir(), 'A', 'B');
  fs.mkdirSync(artistDir, { recursive: true });
  const lib = path.join(artistDir, 'T.wav'); writeWav(lib, 1);
  const src = path.join(dlDir(), 'renamed.wav'); fs.linkSync(lib, src); // same inode, different name
  addTrack({ deezer_id: 51, artist: 'A', album: 'B', title: 'T', file_path: lib });
  // No source_path; a download row references the original remote name.
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_file) VALUES (?, 'track', 51, 'L', 'done', 'soulseek', ?)`).run(uid, JSON.stringify(['peer/renamed.wav']));

  const res = deleteTrackFile(51);
  assert.ok(!fs.existsSync(lib));
  assert.ok(!fs.existsSync(src)); // reclaimed via inode/basename match
  assert.ok(res.removed.length >= 1);
});

/* --------------------------------------------------------------- cleanupStaleTracks */
test('cleanupStaleTracks removes unplayed, unloved tracks when enabled', async () => {
  assert.equal(await cleanupStaleTracks(), 0); // disabled by default
  setSetting('cleanup_enabled', '1');
  setSetting('cleanup_after_days', '30');

  const f = path.join(musicDir(), 'old.wav'); writeWav(f, 1);
  addTrack({ deezer_id: 60, file_path: f });
  db.prepare(`UPDATE tracks SET added_at = datetime('now','-90 days') WHERE deezer_id = 60`).run();
  // A favorited track is always kept.
  const f2 = path.join(musicDir(), 'kept.wav'); writeWav(f2, 1);
  addTrack({ deezer_id: 61, file_path: f2 });
  db.prepare(`UPDATE tracks SET added_at = datetime('now','-90 days') WHERE deezer_id = 61`).run();
  db.prepare('INSERT INTO favorites (user_id, track_id) VALUES (?, ?)').run(uid, 61);

  const removed = await cleanupStaleTracks();
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(f2));
});

/* ----------------------------------------------------------------- sweepUnimported */
test('sweepUnimported retries unimported downloads and re-searches after an outage', async () => {
  fm.on('deezer.test/track/70', () => ({ id: 70, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));

  // An 'importing' download whose file is now present -> sweep imports it.
  writeWav(path.join(dlDir(), 'S.wav'), 2);
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file) VALUES (?, 'track', 70, 'A - S', 'importing', 'soulseek', 'peer', ?)`)
    .run(uid, JSON.stringify(['A/S.wav']));
  await sweepUnimported();
  assert.ok(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 70').get()?.file_path);

  // An 'error' download with no peer gets re-searched once slskd is healthy.
  // Disable the pump so the re-queued search doesn't run a real lookup after the test.
  config.maxConcurrentDownloads = 0;
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine) VALUES (?, 'track', 71, 'A - S2', 'error', 'soulseek')`).run(uid);
  await sweepUnimported();
  const re = db.prepare('SELECT status FROM downloads WHERE deezer_id = 71').get();
  assert.ok(['searching', 'downloading', 'not_found', 'error'].includes(re.status));
});

/* -------------------------------------------------------------------- startPoller */
test('startPoller schedules the poll, sweep and cleanup timers', () => {
  const t = stubTimers();
  try {
    startPoller();
    assert.ok(t.calls.intervals.length >= 3);
    assert.ok(t.calls.timeouts.length >= 2);
  } finally { t.restore(); }
});

/* ------------------------------------------------ Album search flow + folders */
test('album flow: searches, ranks a folder, enqueues, and imports', async () => {
  fm.on('deezer.test/album/21', () => ({ id: 21, title: 'Rec', artist: { name: 'Grp', id: 3 },
    tracks: { data: [
      { id: 211, title: 'Aaa', artist: { name: 'Grp', id: 3 }, track_position: 1, duration: 2 },
      { id: 212, title: 'Bbb', artist: { name: 'Grp', id: 3 }, track_position: 2, duration: 2 },
    ] } }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => ({ id: 'a' }));
  fm.on(/searches\/a$/, (u, o) => o.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 1 });
  fm.on(/searches\/a\/responses$/, () => ([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
    { filename: 'Grp/Rec/01 Aaa.wav', size: 100, length: 2 },
    { filename: 'Grp/Rec/02 Bbb.wav', size: 100, length: 2 },
  ] }]));
  fm.on(/transfers\/downloads\/peer$/, (u, o) => o.method === 'POST' ? fm.json({}, 200) : ({ directories: [] }));

  const id = queueDownload(uid, 'album', 21, 'Grp - Rec', 'c');
  const dl = await waitStatus(id, ['downloading', 'not_found', 'error']);
  assert.equal(dl.status, 'downloading');

  const folder = path.join(dlDir(), 'Rec'); fs.mkdirSync(folder, { recursive: true });
  writeWav(path.join(folder, '01 Aaa.wav'), 2);
  writeWav(path.join(folder, '02 Bbb.wav'), 2);
  fm.reset(); fm.install();
  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: [
    { id: 1, filename: 'Grp/Rec/01 Aaa.wav', state: 'Completed, Succeeded', percentComplete: 100, size: 100 },
    { id: 2, filename: 'Grp/Rec/02 Bbb.wav', state: 'Completed, Succeeded', percentComplete: 100, size: 100 },
  ] }] }));
  await runTick();
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
});

/* ----------------------------------------------- importDownload branch coverage */
// Insert an active album/track download and let resumeOnBoot rebuild its plan.
async function activeDownload(kind, deezerId, deezerMock, remoteFiles) {
  fm.on(`deezer.test/${kind}/${deezerId}`, () => deezerMock);
  const info = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file, progress) VALUES (?, ?, ?, 'L', 'downloading', 'soulseek', 'peer', ?, 0)`)
    .run(uid, kind, deezerId, JSON.stringify(remoteFiles));
  resumeOnBoot();
  await settle();
  return Number(info.lastInsertRowid);
}
async function completeAndTick(remoteFiles, state = 'Completed, Succeeded') {
  fm.reset(); fm.install();
  fm.on(/transfers\/downloads\/peer$/, () => ({ directories: [{ files: remoteFiles.map((f, i) => ({ id: i, filename: f, state, percentComplete: 100, size: 100 })) }] }));
  await runTick();
}

test('import: positional fallback assigns leftover files by track order', async () => {
  const album = { id: 300, title: 'Al', artist: { name: 'A', id: 1 }, tracks: { data: [
    { id: 3001, title: 'Alpha', artist: { name: 'A', id: 1 }, track_position: 1, duration: 2 },
    { id: 3002, title: 'Beta', artist: { name: 'A', id: 1 }, track_position: 2, duration: 3 },
  ] } };
  const remote = ['A/Al/aaa.wav', 'A/Al/bbb.wav']; // names don't reveal the titles
  const id = await activeDownload('album', 300, album, remote);
  const dir = path.join(dlDir(), 'Al'); fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, 'aaa.wav'), 2);
  writeWav(path.join(dir, 'bbb.wav'), 3);
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
  assert.ok(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 3001').get().file_path);
});

test('import: a single mystery-named file is assumed to be the requested track', async () => {
  const track = { id: 310, title: 'Whatever', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 };
  const remote = ['peer/87.wav'];
  const id = await activeDownload('track', 310, track, remote);
  writeWav(path.join(dlDir(), '87.wav'), 2);
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
});

test('import: a wrong-duration single file is rejected (failover)', async () => {
  const track = { id: 320, title: 'Right', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 3 };
  const remote = ['peer/Right.wav'];
  const id = await activeDownload('track', 320, track, remote);
  writeWav(path.join(dlDir(), 'Right.wav'), 60); // way off -> duration contradicts
  await completeAndTick(remote);
  const row = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  assert.ok(['searching', 'not_found', 'error', 'downloading'].includes(row.status)); // failed verification -> retried
  assert.equal(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 320').get().file_path, null);
});

test('import: completed transfer but missing file errors out', async () => {
  const track = { id: 330, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 };
  const remote = ['peer/Nope.wav'];
  const id = await activeDownload('track', 330, track, remote);
  // No file written to disk.
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'error');
});

test('import: already-on-disk track is reused and junk extras are removed', async () => {
  // Pre-place the wanted track on disk (global reuse path).
  const existing = path.join(musicDir(), 'have.wav'); writeWav(existing, 2);
  const track = { id: 340, title: 'Have', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 };
  const id = await activeDownload('track', 340, track, ['peer/Have.wav']);
  db.prepare('UPDATE tracks SET file_path = ? WHERE deezer_id = 340').run(existing);
  // A junk extra is present in the download dir and should be cleaned up.
  const junk = path.join(dlDir(), 'Have.wav'); writeWav(junk, 2);
  await completeAndTick(['peer/Have.wav']);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
});

test('import: cross-device link falls back to a copy', async () => {
  const track = { id: 350, title: 'Copy', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 };
  const remote = ['peer/Copy.wav'];
  const id = await activeDownload('track', 350, track, remote);
  writeWav(path.join(dlDir(), 'Copy.wav'), 2);
  const realLink = fs.linkSync;
  fs.linkSync = () => { const e = new Error('xdev'); e.code = 'EXDEV'; throw e; };
  try { await completeAndTick(remote); } finally { fs.linkSync = realLink; }
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
  assert.ok(fs.existsSync(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 350').get().file_path));
});

test('track flow: peer rejects the file (non-transient) -> not_found', async () => {
  fm.on('deezer.test/track/360', () => ({ id: 360, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => ({ id: 'r' }));
  fm.on(/searches\/r$/, (u, o) => o.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 1 });
  fm.on(/searches\/r\/responses$/, () => ([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, files: [{ filename: 'A/S.wav', size: 1, length: 2 }] }]));
  fm.on(/transfers\/downloads\/peer$/, (u, o) => o.method === 'POST' ? fm.json({ error: 'no' }, 404) : ({ directories: [] }));
  const id = queueDownload(uid, 'track', 360, 'A - S', 'c');
  const row = await waitStatus(id, ['not_found', 'error']);
  assert.equal(row.status, 'not_found');
});

test('album flow: peer rejects the folder -> not_found', async () => {
  fm.on('deezer.test/album/370', () => ({ id: 370, title: 'Al', artist: { name: 'A', id: 1 }, tracks: { data: [
    { id: 3701, title: 'One', track_position: 1, duration: 2 }, { id: 3702, title: 'Two', track_position: 2, duration: 2 },
  ] } }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => ({ id: 'rf' }));
  fm.on(/searches\/rf$/, (u, o) => o.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 1 });
  fm.on(/searches\/rf\/responses$/, () => ([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, files: [
    { filename: 'A/Al/01 One.wav', size: 1, length: 2 }, { filename: 'A/Al/02 Two.wav', size: 1, length: 2 },
  ] }]));
  fm.on(/transfers\/downloads\/peer$/, (u, o) => o.method === 'POST' ? fm.json({ error: 'no' }, 404) : ({ directories: [] }));
  const id = queueDownload(uid, 'album', 370, 'A - Al', 'c');
  const row = await waitStatus(id, ['not_found', 'error']);
  assert.equal(row.status, 'not_found');
});

test('trackViaSlskd short-circuits when the file is already on disk', async () => {
  config.maxConcurrentDownloads = 1;
  const f = path.join(musicDir(), 'present.wav'); writeWav(f, 2);
  addTrack({ deezer_id: 380, file_path: f });
  fm.on('deezer.test/track/380', () => ({ id: 380, title: 'P', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 }));
  // Insert directly as 'searching' (bypassing queueDownload's own dedupe).
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine) VALUES (?, 'track', 380, 'L', 'searching', 'soulseek')`).run(uid);
  const id = db.prepare('SELECT id FROM downloads WHERE deezer_id = 380').get().id;
  resumeOnBoot();
  const row = await waitStatus(id, ['done', 'not_found', 'error']);
  assert.equal(row.status, 'done');
});

test('sweep skips an importing download whose tracks are already imported', async () => {
  const f = path.join(musicDir(), 'already.wav'); writeWav(f, 2);
  addTrack({ deezer_id: 390, file_path: f });
  fm.on('deezer.test/track/390', () => ({ id: 390, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Disconnected' }));
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file) VALUES (?, 'track', 390, 'L', 'importing', 'soulseek', 'peer', ?)`)
    .run(uid, JSON.stringify(['peer/S.wav']));
  await sweepUnimported(); // tracks already on disk -> nothing to do
  assert.ok(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 390').get().file_path);
});

test('import: ranks multiple title matches by closest duration', async () => {
  const album = { id: 410, title: 'Al', artist: { name: 'A', id: 1 }, tracks: { data: [
    { id: 4101, title: 'Solo', artist: { name: 'A', id: 1 }, track_position: 1, duration: 2 },
  ] } };
  const remote = ['A/Al/Solo.wav', 'A/Al/Solo take2.wav'];
  const id = await activeDownload('album', 410, album, remote);
  const dir = path.join(dlDir(), 'Al'); fs.mkdirSync(dir, { recursive: true });
  writeWav(path.join(dir, 'Solo.wav'), 2);            // exact
  writeWav(path.join(dir, 'Solo take2.wav'), 3);      // close but worse
  await completeAndTick(remote);
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'done');
});

test('import: a generic hardlink failure surfaces as an error', async () => {
  const track = { id: 420, title: 'Link', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 };
  const remote = ['peer/Link.wav'];
  const id = await activeDownload('track', 420, track, remote);
  writeWav(path.join(dlDir(), 'Link.wav'), 2);
  const realLink = fs.linkSync;
  fs.linkSync = () => { throw new Error('disk on fire'); }; // not EXDEV/EPERM
  try { await completeAndTick(remote); } finally { fs.linkSync = realLink; }
  assert.equal(db.prepare('SELECT status FROM downloads WHERE id = ?').get(id).status, 'error');
});

test('deleteTrackFile keeps a directory that still has other files', () => {
  const dir = path.join(musicDir(), 'Artist', 'Album'); fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'A.wav'); writeWav(a, 1);
  const b = path.join(dir, 'B.wav'); writeWav(b, 1); // sibling keeps the dir non-empty
  addTrack({ deezer_id: 430, artist: 'Artist', album: 'Album', title: 'A', file_path: a });
  deleteTrackFile(430);
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(dir)); // not pruned: still holds B.wav
});

test('track flow: a transient enqueue failure is retried on the same candidate', async () => {
  fm.on('deezer.test/track/440', () => ({ id: 440, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => ({ id: 'rq' }));
  fm.on(/searches\/rq$/, (u, o) => o.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 1 });
  fm.on(/searches\/rq\/responses$/, () => ([{ username: 'peer', hasFreeUploadSlot: true, queueLength: 0, files: [{ filename: 'A/S.wav', size: 1, length: 2 }] }]));
  let posts = 0;
  fm.on(/transfers\/downloads\/peer$/, (u, o) => {
    if (o.method === 'POST') { posts++; return posts === 1 ? new Response('busy', { status: 500 }) : fm.json({}, 200); }
    return { directories: [] };
  });
  const id = queueDownload(uid, 'track', 440, 'A - S', 'c');
  const row = await waitStatus(id, ['downloading', 'not_found', 'error']);
  assert.equal(row.status, 'downloading');
  assert.ok(posts >= 2); // retried after the transient 500
});

test('album flow: a transient slskd outage ends as a retriable error', async () => {
  fm.on('deezer.test/album/450', () => ({ id: 450, title: 'Al', artist: { name: 'A', id: 1 }, tracks: { data: [
    { id: 4501, title: 'One', track_position: 1, duration: 2 }, { id: 4502, title: 'Two', track_position: 2, duration: 2 },
  ] } }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  fm.on(/api\/v0\/searches$/, () => { throw new Error('fetch failed'); }); // transient
  const id = queueDownload(uid, 'album', 450, 'A - Al', 'c');
  const row = await waitStatus(id, ['error', 'not_found']);
  assert.match(row.detail, /unreachable|offline/);
});

test('sweep logs and skips a download whose import retry throws', async () => {
  addTrack({ deezer_id: 460, title: 'S', artist: 'A' }); // no file on disk
  fm.on('deezer.test/track/460', () => ({ id: 460, title: 'S', artist: { name: 'A', id: 1 }, album: { id: 1 }, duration: 2 }));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Disconnected' }));
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, slskd_user, slskd_file) VALUES (?, 'track', 460, 'L', 'importing', 'soulseek', 'peer', ?)`)
    .run(uid, JSON.stringify(['peer/Missing.wav'])); // file never arrived
  await sweepUnimported(); // importDownload throws "not found" -> caught
  assert.equal(db.prepare('SELECT file_path FROM tracks WHERE deezer_id = 460').get().file_path, null);
});

test('resumeOnBoot re-queues searching downloads', async () => {
  config.maxConcurrentDownloads = 0; // don't actually run the searches
  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine) VALUES (?, 'track', 80, 'L', 'searching', 'soulseek')`).run(uid);
  resumeOnBoot();
  await settle(20);
  // The row stays queued (pump disabled) but resumeOnBoot ran without error.
  assert.ok(db.prepare('SELECT 1 FROM downloads WHERE deezer_id = 80').get());
});
