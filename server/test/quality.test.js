import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config, setSetting, db } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { stubTimers } from './helpers/timers.js';
import { writeWav } from './helpers/wav.js';
import { createUser, addTrack, wipe } from './helpers/seed.js';
import {
  formatOf, candidateBitrate, qualityGate, formatPreference, meetsTarget,
  upgradeProfile, readAudioQuality,
} from '../quality.js';
import {
  backfillQuality, upgradeCandidates, markUpgradeChecked, runUpgradeSweep, startUpgradeWatcher,
} from '../upgrade.js';

let uid;
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

// Put a track in the library with a known quality.
function libTrack(id, { format = 'mp3', bitrate = 192, ...rest } = {}) {
  const f = path.join(config.musicDir, `${id}.${format}`);
  writeWav(f, 1);
  addTrack({ deezer_id: id, file_path: f, ...rest });
  db.prepare('UPDATE tracks SET audio_format = ?, bitrate = ? WHERE deezer_id = ?').run(format, bitrate, id);
  return f;
}

beforeEach(() => {
  wipe();
  fm.install();
  config.maxConcurrentDownloads = 0;         // queueDownload only writes its row
  for (const key of ['quality_accepted', 'quality_min_bitrate', 'quality_target',
    'quality_upgrade_enabled', 'download_format']) setSetting(key, '');
  setSetting('quality_target', '');
  fs.rmSync(config.musicDir, { recursive: true, force: true });
  fs.mkdirSync(config.musicDir, { recursive: true });
  uid = createUser({ username: 'admin', is_admin: 1 }).id;
});
afterEach(() => fm.uninstall());

/* ------------------------------------------------------------- primitives */
test('formatOf normalizes the container, whatever the case', () => {
  assert.equal(formatOf('/music/A/B/Song.FLAC'), 'flac');
  assert.equal(formatOf('Song.mp3'), 'mp3');
  assert.equal(formatOf('noextension'), '');
  assert.equal(formatOf(null), '');
});

test('candidateBitrate prefers what slskd reports and estimates otherwise', () => {
  assert.equal(candidateBitrate({ bitRate: 320 }), 320);
  // 5 MB over 200s ≈ 200kbps.
  assert.equal(candidateBitrate({ size: 5_000_000, length: 200 }), 200);
  assert.equal(candidateBitrate({ size: 5_000_000 }), null);   // no length to divide by
  assert.equal(candidateBitrate({ length: 0, size: 10 }), null);
  assert.equal(candidateBitrate(null), null);
});

test('the quality gate accepts by format and by bitrate floor', () => {
  const gate = qualityGate({ accepted: ['flac', 'mp3'], minBitrate: 256 });
  assert.equal(gate({ filename: 'a/b.flac' }), true);              // lossless ignores the floor
  assert.equal(gate({ filename: 'a/b.mp3', bitRate: 320 }), true);
  assert.equal(gate({ filename: 'a/b.mp3', bitRate: 128 }), false);
  assert.equal(gate({ filename: 'a/b.mp3' }), true);               // unmeasurable: kept
  assert.equal(gate({ filename: 'a/b.m4a', bitRate: 320 }), false); // not accepted at all
  // No floor configured: every accepted format passes.
  assert.equal(qualityGate({ accepted: ['mp3'] })({ filename: 'x.mp3', bitRate: 64 }), true);
});

test('format preference ranks by the profile order, best first', () => {
  const p = { accepted: ['mp3', 'flac'] };
  assert.equal(formatPreference('a.mp3', p), 30);
  assert.equal(formatPreference('a.flac', p), 0);
  assert.equal(formatPreference('a.ogg', p), 0);        // not accepted, no bonus
  // A single-format profile gives its one format the full bonus.
  assert.equal(formatPreference('a.flac', { accepted: ['flac'] }), 30);
  // The middle of a longer list sits in between.
  const three = { accepted: ['flac', 'm4a', 'mp3'] };
  assert.equal(formatPreference('a.m4a', three), 15);
});

/* ------------------------------------------------------------ the target */
test('meetsTarget treats lossless as the ceiling', () => {
  const opts = { target: 'flac', minBitrate: 0 };
  assert.equal(meetsTarget({ audio_format: 'flac' }, opts), true);
  assert.equal(meetsTarget({ audio_format: 'wav' }, opts), true);
  assert.equal(meetsTarget({ audio_format: 'mp3', bitrate: 320 }, opts), false);
  // A lossy target never downgrades a lossless file.
  assert.equal(meetsTarget({ audio_format: 'flac' }, { target: 'mp3', minBitrate: 320 }), true);
});

test('meetsTarget applies the bitrate floor to a lossy target', () => {
  const opts = { target: 'mp3', minBitrate: 256 };
  assert.equal(meetsTarget({ audio_format: 'mp3', bitrate: 320 }, opts), true);
  assert.equal(meetsTarget({ audio_format: 'mp3', bitrate: 192 }, opts), false);
  assert.equal(meetsTarget({ audio_format: 'mp3', bitrate: null }, opts), false);
  assert.equal(meetsTarget({ audio_format: 'm4a', bitrate: 320 }, opts), false);
  // No floor: the format alone decides.
  assert.equal(meetsTarget({ audio_format: 'mp3', bitrate: 96 }, { target: 'mp3', minBitrate: 0 }), true);
});

test('meetsTarget is satisfied by everything when no target is set, and suspicious of unknowns', () => {
  assert.equal(meetsTarget({ audio_format: 'mp3', bitrate: 64 }, { target: '' }), true);
  assert.equal(meetsTarget({ audio_format: null }, { target: 'flac' }), false);
});

test('an upgrade searches only for the target format', () => {
  setSetting('quality_target', 'flac');
  setSetting('quality_min_bitrate', '192');
  assert.deepEqual(upgradeProfile(), { accepted: ['flac'], minBitrate: 192 });
});

/* --------------------------------------------------------- reading files */
test('readAudioQuality reports what is in the file, and survives what is not', async () => {
  const good = path.join(config.musicDir, 'real.wav');
  writeWav(good, 2);
  const q = await readAudioQuality(good);
  assert.equal(q.format, 'wav');
  assert.ok(q.bitrate > 0);

  // Unparseable content still yields the extension rather than throwing.
  const bad = path.join(config.musicDir, 'broken.mp3');
  fs.writeFileSync(bad, 'not audio at all');
  assert.deepEqual(await readAudioQuality(bad), { format: 'mp3', bitrate: null });
  assert.deepEqual(await readAudioQuality('/does/not/exist.flac'), { format: 'flac', bitrate: null });
});

/* -------------------------------------------------------------- backfill */
test('backfillQuality records the quality of files imported before it existed', async () => {
  const f = path.join(config.musicDir, 'old.wav');
  writeWav(f, 2);
  addTrack({ deezer_id: 8001, file_path: f });
  // A row whose file has since vanished must not stop the pass.
  addTrack({ deezer_id: 8002, file_path: '/gone/missing.flac' });

  assert.equal(await backfillQuality(), 1);
  const row = db.prepare('SELECT audio_format, bitrate FROM tracks WHERE deezer_id = 8001').get();
  assert.equal(row.audio_format, 'wav');
  assert.ok(row.bitrate > 0);
  assert.equal(db.prepare('SELECT audio_format FROM tracks WHERE deezer_id = 8002').get().audio_format, null);
  // Already-known rows aren't reopened on the next pass.
  assert.equal(await backfillQuality(), 0);
});

/* ------------------------------------------------------------ candidates */
test('upgradeCandidates picks the tracks that are below the target', () => {
  libTrack(8101, { format: 'mp3', bitrate: 192 });
  libTrack(8102, { format: 'flac', bitrate: 900 });
  setSetting('quality_target', 'flac');
  assert.deepEqual(upgradeCandidates().map(t => t.deezer_id), [8101]);

  // No target: nothing is ever below it.
  setSetting('quality_target', '');
  assert.deepEqual(upgradeCandidates(), []);
});

test('upgradeCandidates skips tracks already being upgraded, and honours the batch size', () => {
  setSetting('quality_target', 'flac');
  for (const id of [8201, 8202, 8203]) libTrack(id, { format: 'mp3', bitrate: 128 });
  assert.equal(upgradeCandidates().length, 3);
  assert.equal(upgradeCandidates(2).length, 2);

  db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, status, engine, is_upgrade)
              VALUES (?, 'track', 8201, 'L', 'downloading', 'soulseek', 1)`).run(uid);
  assert.deepEqual(upgradeCandidates().map(t => t.deezer_id).sort(), [8202, 8203]);

  // A finished upgrade doesn't block a later one.
  db.prepare(`UPDATE downloads SET status = 'done' WHERE deezer_id = 8201`).run();
  assert.equal(upgradeCandidates().length, 3);
});

test('a track nobody shares in the target format drops out until the recheck window', () => {
  setSetting('quality_target', 'flac');
  libTrack(8301, { format: 'mp3', bitrate: 128 });
  markUpgradeChecked(8301);
  assert.deepEqual(upgradeCandidates(), []);

  // ...and comes back once the stamp is old enough.
  db.prepare(`UPDATE tracks SET upgrade_checked_at = datetime('now', '-40 days') WHERE deezer_id = 8301`).run();
  assert.deepEqual(upgradeCandidates().map(t => t.deezer_id), [8301]);
});

test('tracks outside the library, or of unknown quality, are left alone', () => {
  setSetting('quality_target', 'flac');
  const f = libTrack(8401, { format: 'mp3', bitrate: 128 });
  db.prepare('UPDATE tracks SET in_library = 0 WHERE deezer_id = 8401').run();
  assert.deepEqual(upgradeCandidates(), []);

  // Quality not recorded yet: the backfill's job, not the sweep's.
  db.prepare('UPDATE tracks SET in_library = 1, audio_format = NULL WHERE deezer_id = 8401').run();
  assert.deepEqual(upgradeCandidates(), []);
  assert.ok(fs.existsSync(f));
});

/* ---------------------------------------------------------------- sweeps */
test('the sweep queues one upgrade download per candidate and stamps it', async () => {
  setSetting('quality_target', 'flac');
  setSetting('quality_upgrade_enabled', '1');
  libTrack(8501, { format: 'mp3', bitrate: 192, title: 'Song', artist: 'A' });

  assert.equal(await runUpgradeSweep(), 1);
  const dl = db.prepare('SELECT * FROM downloads WHERE deezer_id = 8501').get();
  assert.equal(dl.is_upgrade, 1);
  assert.equal(dl.kind, 'track');
  assert.equal(dl.user_id, uid);                      // attributed to an admin
  assert.match(dl.label, /A – Song/);
  assert.ok(db.prepare('SELECT upgrade_checked_at FROM tracks WHERE deezer_id = 8501').get().upgrade_checked_at);

  // The now-running upgrade means a second sweep finds nothing to do.
  assert.equal(await runUpgradeSweep(), 0);
});

test('the sweep does nothing while it is switched off, and the manual run overrides that', async () => {
  setSetting('quality_target', 'flac');
  setSetting('quality_upgrade_enabled', '0');
  libTrack(8601, { format: 'mp3', bitrate: 192 });

  assert.equal(await runUpgradeSweep(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n, 0);

  assert.equal(await runUpgradeSweep({ force: true }), 1);
  // Even forced, there has to be a target to aim at.
  setSetting('quality_target', '');
  assert.equal(await runUpgradeSweep({ force: true }), 0);
});

test('the sweep backfills unknown quality before deciding, and needs an admin', async () => {
  setSetting('quality_target', 'flac');
  setSetting('quality_upgrade_enabled', '1');
  const f = path.join(config.musicDir, 'unknown.wav');
  writeWav(f, 1);
  addTrack({ deezer_id: 8701, file_path: f });        // no audio_format recorded

  // wav is lossless, so once measured it already meets a flac target.
  assert.equal(await runUpgradeSweep(), 0);
  assert.equal(db.prepare('SELECT audio_format FROM tracks WHERE deezer_id = 8701').get().audio_format, 'wav');

  // With no admin to attribute the maintenance to, the sweep declines.
  libTrack(8702, { format: 'mp3', bitrate: 128 });
  db.prepare('UPDATE users SET is_admin = 0').run();
  assert.equal(await runUpgradeSweep(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n, 0);
});

test('the watcher only schedules itself when there is a target', async () => {
  setSetting('quality_target', '');
  setSetting('quality_upgrade_enabled', '1');
  assert.equal(startUpgradeWatcher(), null);

  setSetting('quality_target', 'flac');
  libTrack(8801, { format: 'mp3', bitrate: 128 });
  const t = stubTimers();
  try {
    assert.ok(startUpgradeWatcher());
    const tick = t.calls.intervals[0];
    t.restore();
    await tick();
    await settle();
  } finally { t.restore(); }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE is_upgrade = 1').get().n, 1);
});
