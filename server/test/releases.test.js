import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config, setSetting } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { stubTimers } from './helpers/timers.js';
import { seedSeenAlbums, checkFollowedArtists, startReleaseWatcher } from '../releases.js';
import { createUser, wipe, db } from './helpers/seed.js';

beforeEach(() => {
  wipe();
  fm.install();
  // Neutralise the download concurrency pump so queueDownload only writes its
  // row (no background slskd search to leak between tests).
  config.maxConcurrentDownloads = 0;
  setSetting('slskd_url', 'https://slskd.test');
  setSetting('slskd_api_key', 'k');
});
afterEach(() => { fm.uninstall(); });

test('seedSeenAlbums records the back-catalogue (and swallows errors)', async () => {
  fm.on('deezer.test/artist/1/albums', () => ({ data: [{ id: 10 }, { id: 11 }] }));
  await seedSeenAlbums(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_artist_albums WHERE artist_id = 1').get().n, 2);

  fm.on('deezer.test/artist/2/albums', () => { throw new Error('deezer down'); });
  await seedSeenAlbums(2); // must not throw
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_artist_albums WHERE artist_id = 2').get().n, 0);
});

test('checkFollowedArtists returns 0 when slskd is disabled or no one is followed', async () => {
  setSetting('slskd_url', '');
  assert.equal(await checkFollowedArtists(), 0);          // disabled
  setSetting('slskd_url', 'https://slskd.test');
  assert.equal(await checkFollowedArtists(), 0);          // no followed artists
});

test('checkFollowedArtists queues fresh releases, honouring type filter and seen set', async () => {
  const u = createUser({ username: 'u' });
  db.prepare('INSERT INTO followed_artists (user_id, artist_id, artist_name) VALUES (?, ?, ?)').run(u.id, 1, 'Artist');
  // 11 already seen; 12 is a compilation (filtered); 13/14 are fresh and queueable.
  db.prepare('INSERT INTO seen_artist_albums (artist_id, album_id, queued) VALUES (1, 11, 1)').run();
  fm.on('deezer.test/artist/1/albums', () => ({ data: [
    { id: 11, title: 'Old', record_type: 'album', release_date: '2020-01-01' },
    { id: 12, title: 'Best Of', record_type: 'compilation', release_date: '2024-01-01' },
    { id: 13, title: 'New EP', record_type: 'ep', release_date: '2024-06-01' },
    { id: 14, title: 'Single', record_type: 'single', release_date: '2024-05-01', cover_medium: 'c' },
  ] }));
  const queued = await checkFollowedArtists();
  assert.equal(queued, 2);
  assert.ok(db.prepare('SELECT 1 FROM seen_artist_albums WHERE artist_id = 1 AND album_id = 13').get());
  assert.ok(!db.prepare('SELECT 1 FROM seen_artist_albums WHERE artist_id = 1 AND album_id = 12').get()); // filtered
});

test('checkFollowedArtists caps per artist per run and logs per-artist failures', async () => {
  // Distinct artist ids from other tests so the URL-keyed Deezer cache can't
  // serve a stale album list within this process.
  const u = createUser({ username: 'u' });
  db.prepare('INSERT INTO followed_artists (user_id, artist_id, artist_name) VALUES (?, ?, ?)').run(u.id, 3, 'Prolific');
  db.prepare('INSERT INTO followed_artists (user_id, artist_id, artist_name) VALUES (?, ?, ?)').run(u.id, 4, 'Broken');
  const many = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, title: `A${i}`, record_type: 'album', release_date: `2024-01-0${i + 1}` }));
  fm.on('deezer.test/artist/3/albums', () => ({ data: many }));
  fm.on('deezer.test/artist/4/albums', () => { throw new Error('boom'); });
  const queued = await checkFollowedArtists();
  assert.equal(queued, 5); // capped at MAX_PER_ARTIST_PER_RUN for artist 1; artist 2 errored
});

test('checkFollowedArtists logs and skips an album whose queue insert fails', async () => {
  const u = createUser({ username: 'u' });
  db.prepare('INSERT INTO followed_artists (user_id, artist_id, artist_name) VALUES (?, ?, ?)').run(u.id, 7, 'Glitchy');
  // A null id makes queueDownload's NOT NULL insert throw -> the per-album catch.
  fm.on('deezer.test/artist/7/albums', () => ({ data: [
    { id: null, title: 'Bad', record_type: 'album', release_date: '2024-02-01' },
    { id: 700, title: 'Good', record_type: 'album', release_date: '2024-01-01' },
  ] }));
  const queued = await checkFollowedArtists();
  assert.equal(queued, 1); // the good one; the broken insert was caught
});

test('startReleaseWatcher schedules when enabled and no-ops when disabled', () => {
  const t = stubTimers();
  try {
    config.releaseWatchEnabled = true;
    startReleaseWatcher();
    assert.equal(t.calls.timeouts.length, 1);
    assert.equal(t.calls.intervals.length, 1);
    // Invoke the scheduled callbacks to cover their bodies (errors are swallowed).
    t.calls.timeouts[0]();
    t.calls.intervals[0]();

    config.releaseWatchEnabled = false;
    const before = t.calls.intervals.length;
    startReleaseWatcher();
    assert.equal(t.calls.intervals.length, before); // disabled -> nothing scheduled
  } finally { t.restore(); config.releaseWatchEnabled = true; }
});
