import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  db, config, getSetting, setSetting, upsertTrack, trackRowFromDeezer,
  pingDb, avatarPath, avatarUrl,
} from '../db.js';

test('getSetting/setSetting round-trip and upsert semantics', () => {
  assert.equal(getSetting('nope'), null);
  setSetting('k', 'v1');
  assert.equal(getSetting('k'), 'v1');
  setSetting('k', 'v2');                 // ON CONFLICT update
  assert.equal(getSetting('k'), 'v2');
});

test('config getters reflect stored settings and defaults', () => {
  setSetting('root_folder', '');         // empty -> falls back to env default
  assert.equal(config.musicDir, process.env.MUSIC_DIR);
  setSetting('root_folder', '/tmp/custom-root');
  assert.equal(config.musicDir, '/tmp/custom-root');

  setSetting('slskd_url', 'https://x.test/');
  assert.equal(config.slskdUrl, 'https://x.test'); // trailing slash trimmed
  assert.equal(config.slskdEnabled, false);        // no key yet
  setSetting('slskd_api_key', 'secret');
  assert.equal(config.slskdEnabled, true);

  setSetting('slskd_download_dir', '');
  assert.equal(config.slskdDownloadDir, process.env.SLSKD_DOWNLOAD_DIR);

  setSetting('cleanup_enabled', '1');
  assert.equal(config.autoCleanupEnabled, true);
  setSetting('cleanup_after_days', '30');
  assert.equal(config.cleanupAfterDays, 30);
  setSetting('cleanup_after_days', 'garbage');       // NaN -> 0
  assert.equal(config.cleanupAfterDays, 0);
  setSetting('cleanup_after_days', '-5');             // clamped to >= 0
  assert.equal(config.cleanupAfterDays, 0);
});

test('upsertTrack inserts then refreshes metadata without touching file_path', () => {
  upsertTrack({ deezer_id: 1, title: 'A', artist: 'Ar', artist_id: 1, album: 'Al', album_id: 2, track_position: 1, duration: 100, cover: 'c' });
  db.prepare('UPDATE tracks SET file_path = ? WHERE deezer_id = 1').run('/path/a.flac');
  upsertTrack({ deezer_id: 1, title: 'A2', artist: 'Ar', artist_id: 1, album: 'Al', album_id: 2, track_position: 1, duration: 100, cover: 'c' });
  const row = db.prepare('SELECT title, file_path FROM tracks WHERE deezer_id = 1').get();
  assert.equal(row.title, 'A2');
  assert.equal(row.file_path, '/path/a.flac');   // preserved
});

test('trackRowFromDeezer maps Deezer shapes including overrides and fallbacks', () => {
  const full = trackRowFromDeezer({
    id: 5, title: 'T', artist: { name: 'N', id: 9 },
    album: { title: 'Alb', id: 3, cover_medium: 'cm' }, track_position: 2, duration: 200, isrc: 'X',
  });
  assert.equal(full.artist, 'N');
  assert.equal(full.album_id, 3);
  assert.equal(full.cover, 'cm');

  const bare = trackRowFromDeezer({ id: 6, title: 'T2' }); // no artist/album
  assert.equal(bare.artist, 'Unknown');
  assert.equal(bare.album, null);
  assert.equal(bare.isrc, null);

  const override = trackRowFromDeezer({ id: 7, title: 'T3', album: { id: 1 } }, { title: 'OverAlb', id: 99, cover: 'oc' });
  assert.equal(override.album, 'OverAlb');
  assert.equal(override.album_id, 99);
});

test('pingDb succeeds and avatar helpers behave', () => {
  pingDb();                                            // no throw
  assert.match(avatarPath(3), /3\.jpg$/);
  assert.equal(avatarUrl(999), null);                  // no file -> null
  fs.writeFileSync(avatarPath(3), 'x');
  assert.match(avatarUrl(3), /\/api\/avatar\/3\?v=\d+/);
});
