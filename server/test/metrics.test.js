import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setSetting } from '../db.js';
import { inc, resetCounters, metricsText, registerMetrics, metricsEnabled } from '../metrics.js';
import { setStatus } from '../download/status.js';
import { createUser, addTrack, wipe, db } from './helpers/seed.js';
import { listen, req } from './helpers/app.js';

let srv;

// Parse the exposition format into { "name{labels}": value } so tests can assert
// on samples without depending on line order.
function parse(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

beforeEach(async () => {
  wipe();
  resetCounters();
  delete process.env.METRICS_TOKEN;
  delete process.env.METRICS_ENABLED;
  const app = express();
  registerMetrics(app);
  srv = await listen(app);
});
afterEach(async () => { await srv.close(); });

test('metrics report the library, users and download queue', () => {
  createUser({ username: 'a' });
  createUser({ username: 'b' });
  addTrack({ deezer_id: 1, album_id: 10, file_path: '/lib/1.flac' });
  addTrack({ deezer_id: 2, album_id: 10, file_path: '/lib/2.flac' });
  addTrack({ deezer_id: 3, album_id: 11 });                       // catalog only, not on disk
  db.prepare('INSERT INTO plays (user_id, track_id) VALUES ((SELECT id FROM users LIMIT 1), 1)').run();

  const m = parse(metricsText());
  assert.equal(m.musicarr_users_total, 2);
  assert.equal(m.musicarr_tracks_total, 3);
  assert.equal(m.musicarr_tracks_on_disk, 2);
  assert.equal(m.musicarr_albums_on_disk, 1);
  assert.equal(m.musicarr_plays_total, 1);
  assert.equal(m.musicarr_playlists_total, 0);
  assert.equal(m.musicarr_followed_artists_total, 0);
  assert.ok(m.musicarr_process_resident_memory_bytes > 0);
  assert.ok(m.musicarr_uptime_seconds >= 0);
});

test('downloads are broken down by status, and report zero when there are none', () => {
  assert.equal(parse(metricsText())['musicarr_downloads{status="none"}'], 0);

  const uid = createUser({ username: 'u' }).id;
  const add = (status) => db.prepare(
    `INSERT INTO downloads (user_id, kind, deezer_id, label, status) VALUES (?, 'track', ?, 'x', ?)`
  ).run(uid, Math.floor(Math.random() * 1e9), status);
  add('done'); add('done'); add('not_found');

  const m = parse(metricsText());
  assert.equal(m['musicarr_downloads{status="done"}'], 2);
  assert.equal(m['musicarr_downloads{status="not_found"}'], 1);
});

test('slskd configuration is reported as a gauge', () => {
  assert.equal(parse(metricsText()).musicarr_slskd_configured, 0);
  setSetting('slskd_url', 'https://slskd.test');
  setSetting('slskd_api_key', 'k');
  assert.equal(parse(metricsText()).musicarr_slskd_configured, 1);
  setSetting('slskd_api_key', '');
});

test('counters accumulate per label set and are rendered as counters', () => {
  inc('musicarr_external_requests_total', { service: 'deezer', outcome: 'ok' });
  inc('musicarr_external_requests_total', { service: 'deezer', outcome: 'ok' }, 3);
  inc('musicarr_external_requests_total', { service: 'slskd', outcome: 'error' });
  inc('musicarr_imports_total', { result: 'imported' }, 12);
  inc('musicarr_custom_thing');

  const text = metricsText();
  const m = parse(text);
  assert.equal(m['musicarr_external_requests_total{service="deezer",outcome="ok"}'], 4);
  assert.equal(m['musicarr_external_requests_total{service="slskd",outcome="error"}'], 1);
  assert.equal(m['musicarr_imports_total{result="imported"}'], 12);
  // A counter with no labels renders bare, and every series is typed + described.
  assert.equal(m.musicarr_custom_thing, 1);
  assert.ok(text.includes('# TYPE musicarr_external_requests_total counter'));
  assert.ok(text.includes('# HELP musicarr_custom_thing Musicarr counter.'));
});

test('label values are escaped so a scrape can always be parsed', () => {
  inc('musicarr_test_escaping', { detail: 'a"b\\c\nd' });
  assert.ok(metricsText().includes('musicarr_test_escaping{detail="a\\"b\\\\c\\nd"} 1'));
});

test('download status changes feed the transitions counter', () => {
  const uid = createUser({ username: 'u' }).id;
  const id = Number(db.prepare(
    `INSERT INTO downloads (user_id, kind, deezer_id, label, status) VALUES (?, 'track', 5, 'x', 'searching')`
  ).run(uid).lastInsertRowid);

  setStatus(id, 'downloading');
  setStatus(id, 'done');
  const m = parse(metricsText());
  assert.equal(m['musicarr_download_transitions_total{status="downloading"}'], 1);
  assert.equal(m['musicarr_download_transitions_total{status="done"}'], 1);
});

/* ------------------------------------------------------------ the endpoint */
test('GET /metrics serves the exposition format unauthenticated', async () => {
  addTrack({ deezer_id: 42, file_path: '/lib/42.flac' });
  const r = await req(srv.url, 'GET', '/metrics');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(r.raw.includes('musicarr_tracks_on_disk 1'));
  assert.ok(r.raw.startsWith('# HELP musicarr_build_info'));
});

test('METRICS_ENABLED=false takes the endpoint away', async () => {
  process.env.METRICS_ENABLED = 'false';
  assert.equal(metricsEnabled(), false);
  const r = await req(srv.url, 'GET', '/metrics');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /disabled/);
});

test('METRICS_TOKEN gates the endpoint on both accepted headers', async () => {
  process.env.METRICS_TOKEN = 'scrape-me';
  assert.equal((await req(srv.url, 'GET', '/metrics')).status, 401);
  assert.equal((await req(srv.url, 'GET', '/metrics', { headers: { authorization: 'Bearer nope' } })).status, 401);
  // A wrong-length token is rejected without reaching the constant-time compare.
  assert.equal((await req(srv.url, 'GET', '/metrics', { headers: { 'x-api-key': 'short' } })).status, 401);
  assert.equal((await req(srv.url, 'GET', '/metrics', { headers: { authorization: 'Bearer scrape-me' } })).status, 200);
  assert.equal((await req(srv.url, 'GET', '/metrics', { headers: { 'x-api-key': 'scrape-me' } })).status, 200);
});

test('a collection failure is reported as a 500, not a crash', async () => {
  // Losing a table mid-scrape is the realistic version of this (a corrupted or
  // mid-migration database); the endpoint must degrade rather than take the
  // process down.
  db.exec('ALTER TABLE plays RENAME TO plays_hidden');
  try {
    const r = await req(srv.url, 'GET', '/metrics');
    assert.equal(r.status, 500);
    assert.match(r.body.error, /plays/);
  } finally {
    db.exec('ALTER TABLE plays_hidden RENAME TO plays');
  }
});
