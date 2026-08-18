import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db, setSetting, MB_ID_BASE, isMbId, upsertTrack, trackRowFromDeezer } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { createUser, addTrack, wipe } from './helpers/seed.js';
import { makeAuthedApp, listen, req, setUser } from './helpers/app.js';
import {
  mbLocalId, mbidFor, coverUrlForRelease, trackFromRecording,
  musicbrainzTrack, musicbrainzAlbum, resetMusicbrainz,
} from '../musicbrainz.js';
import { catalogTrack, catalogAlbum, catalogSource } from '../catalog.js';

let srv, user;

const RECORDING = {
  id: 'rec-aaaa',
  title: 'Bâtiment 7',
  length: 187000,
  isrcs: ['FRX123456789'],
  'artist-credit': [{ name: 'Werenoi', artist: { id: 'art-bbbb', name: 'Werenoi' } }],
  releases: [{ id: 'rel-cccc', title: 'Pyramide', date: '2023-03-17' }],
};

const RELEASE = {
  id: 'rel-cccc',
  title: 'Pyramide',
  date: '2023-03-17',
  'artist-credit': [{ name: 'Werenoi' }],
  media: [{
    position: 1,
    tracks: [
      { id: 't1', position: 1, title: 'Intro', length: 120000, recording: { id: 'rec-1', title: 'Intro', length: 120000, isrcs: ['FRX000000001'] } },
      { id: 't2', position: 2, title: 'Bâtiment 7', length: 187000, recording: { id: 'rec-aaaa', title: 'Bâtiment 7', length: 187000, 'artist-credit': [{ name: 'Werenoi' }] } },
    ],
  }],
};

const empty = () => ({ data: [] });

beforeEach(async () => {
  wipe();
  db.prepare('DELETE FROM mb_ids').run();
  resetMusicbrainz();
  fm.install();
  setSetting('musicbrainz_fallback_enabled', '1');
  user = createUser({ username: 'u' });
  setUser({ id: user.id, username: 'u', is_admin: 0 });
  srv = await listen(makeAuthedApp());
});
afterEach(async () => { fm.uninstall(); await srv.close(); });

/* ------------------------------------------------------------ id mapping */
test('an MBID gets a stable synthetic id above the reserved base', () => {
  const a = mbLocalId('rec-aaaa', 'recording');
  assert.ok(a >= MB_ID_BASE);
  assert.equal(isMbId(a), true);
  // Stable: asking again returns the same id rather than allocating another.
  assert.equal(mbLocalId('rec-aaaa', 'recording'), a);
  // Different MBID, different id.
  assert.notEqual(mbLocalId('rec-zzzz', 'recording'), a);
  // Same MBID under a different kind is a different object.
  assert.notEqual(mbLocalId('rec-aaaa', 'release'), a);
  // ...and it maps back.
  assert.equal(mbidFor(a, 'recording'), 'rec-aaaa');
  assert.equal(mbidFor(a, 'release'), null);
  assert.equal(mbLocalId(null, 'recording'), null);
});

test('a Deezer id is never mistaken for a MusicBrainz one', () => {
  assert.equal(isMbId(3135556), false);          // a real-looking Deezer id
  assert.equal(isMbId(MB_ID_BASE - 1), false);
  assert.equal(isMbId(MB_ID_BASE), true);
  assert.equal(mbidFor(3135556, 'recording'), null);
  assert.equal(catalogSource(3135556), 'deezer');
  assert.equal(catalogSource(mbLocalId('x', 'recording')), 'musicbrainz');
});

test('synthetic ids are never reused, even after the row is deleted', () => {
  const first = mbLocalId('rec-gone', 'recording');
  db.prepare('DELETE FROM mb_ids WHERE mbid = ?').run('rec-gone');
  const second = mbLocalId('rec-new', 'recording');
  // A recycled id would silently re-point old playlist rows at another song.
  assert.notEqual(second, first);
});

/* ------------------------------------------------------------ cover art */
test('covers come from the Cover Art Archive, keyed by release', () => {
  assert.match(coverUrlForRelease('rel-cccc'), /\/release\/rel-cccc\/front-500$/);
  assert.match(coverUrlForRelease('rel-cccc', 250), /front-250$/);
  assert.equal(coverUrlForRelease(null), null);
});

/* --------------------------------------------------------------- shaping */
test('a recording is shaped exactly like a Deezer track', () => {
  const t = trackFromRecording(RECORDING);
  assert.equal(t.title, 'Bâtiment 7');
  assert.equal(t.artist.name, 'Werenoi');
  // No artist id: there is no MusicBrainz artist page to link to, and the UI
  // renders a null artist_id as plain text rather than a dead link.
  assert.equal(t.artist.id, null);
  assert.equal(t.album.title, 'Pyramide');
  assert.ok(isMbId(t.album.id));
  assert.equal(t.duration, 187);                 // ms -> s, like Deezer reports
  assert.equal(t.isrc, 'FRX123456789');
  assert.equal(t.source, 'musicbrainz');

  // ...and therefore survives the existing Deezer row builder untouched.
  const row = trackRowFromDeezer(t);
  assert.equal(row.title, 'Bâtiment 7');
  assert.equal(row.artist, 'Werenoi');
  assert.equal(row.artist_id, null);
  assert.equal(row.duration, 187);
  assert.equal(row.isrc, 'FRX123456789');
});

test('upsertTrack records where a row came from, without being told', () => {
  const t = trackFromRecording(RECORDING);
  upsertTrack(trackRowFromDeezer(t));
  assert.equal(db.prepare('SELECT source FROM tracks WHERE deezer_id = ?').get(t.id).source, 'musicbrainz');

  addTrack({ deezer_id: 555 });
  assert.equal(db.prepare('SELECT source FROM tracks WHERE deezer_id = 555').get().source, 'deezer');
});

/* --------------------------------------------------------------- lookups */
test('a release becomes an album with a usable tracklist', async () => {
  fm.on('musicbrainz.test', () => RELEASE);
  const albumId = mbLocalId('rel-cccc', 'release');
  const album = await musicbrainzAlbum(albumId);

  assert.equal(album.title, 'Pyramide');
  assert.equal(album.artist.name, 'Werenoi');
  assert.equal(album.release_date, '2023-03-17');
  assert.equal(album.nb_tracks, 2);
  assert.match(album.cover_medium, /front-250$/);

  const [t1, t2] = album.tracks.data;
  assert.equal(t1.title, 'Intro');
  assert.equal(t1.track_position, 1);
  assert.equal(t1.disk_number, 1);
  assert.equal(t1.duration, 120);
  assert.equal(t1.isrc, 'FRX000000001');
  // The track's own credit wins where it has one, else the release artist.
  assert.equal(t2.artist.name, 'Werenoi');
  assert.ok(isMbId(t2.id));

  // Which is exactly what the importer's plan builder consumes.
  const wanted = album.tracks.data.map(t => trackRowFromDeezer(t, album));
  assert.deepEqual(wanted.map(w => w.title), ['Intro', 'Bâtiment 7']);
  assert.deepEqual(wanted.map(w => w.track_position), [1, 2]);
  assert.equal(wanted[0].album, 'Pyramide');
});

test('an unknown synthetic id is an error, not a silent empty result', async () => {
  await assert.rejects(musicbrainzTrack(MB_ID_BASE + 9999), /Unknown MusicBrainz track/);
  await assert.rejects(musicbrainzAlbum(MB_ID_BASE + 9999), /Unknown MusicBrainz album/);

  // Allocated, but MusicBrainz doesn't return it.
  fm.on('musicbrainz.test', () => ({}));
  await assert.rejects(musicbrainzTrack(mbLocalId('rec-ghost', 'recording')), /not found/);
  await assert.rejects(musicbrainzAlbum(mbLocalId('rel-ghost', 'release')), /not found/);
});

/* -------------------------------------------------------------- dispatch */
test('the catalog picks its service from the id alone', async () => {
  const asked = [];
  fm.on('deezer.test', (url) => { asked.push(url); return { id: 42, title: 'Deezer song' }; });
  fm.on('musicbrainz.test', (url) => { asked.push(url); return RECORDING; });

  assert.equal((await catalogTrack(42)).title, 'Deezer song');
  assert.match(asked[0], /deezer\.test\/track\/42/);

  const mbTrackId = mbLocalId('rec-aaaa', 'recording');
  assert.equal((await catalogTrack(mbTrackId)).title, 'Bâtiment 7');
  assert.match(asked[1], /musicbrainz\.test.*recording\/rec-aaaa/);

  fm.reset(); fm.install(); resetMusicbrainz();
  fm.on('deezer.test', () => ({ id: 7, title: 'Deezer album' }));
  fm.on('musicbrainz.test', () => RELEASE);
  assert.equal((await catalogAlbum(7)).title, 'Deezer album');
  assert.equal((await catalogAlbum(mbLocalId('rel-cccc', 'release'))).title, 'Pyramide');
});

/* -------------------------------------------------------- search fallback */
test('MusicBrainz is searched only when Deezer comes back completely empty', async () => {
  let mbCalls = 0;
  fm.on('deezer.test/search/', empty);
  fm.on('musicbrainz.test', () => { mbCalls++; return { releases: [RELEASE], recordings: [RECORDING] }; });

  const r = await req(srv.url, 'GET', '/api/search?q=werenoi');
  assert.equal(r.status, 200);
  assert.ok(mbCalls > 0);
  assert.equal(r.body.tracks[0].title, 'Bâtiment 7');
  assert.equal(r.body.tracks[0].source, 'musicbrainz');
  assert.equal(r.body.albums[0].title, 'Pyramide');
  assert.match(r.body.albums[0].cover, /front-250$/);
  // No artist tiles: a MusicBrainz artist has no page to open.
  assert.deepEqual(r.body.artists, []);
});

test('a partial Deezer result is left alone — no catalogs mixed mid-search', async () => {
  let mbCalls = 0;
  fm.on('deezer.test/search/artist', empty);
  fm.on('deezer.test/search/album', empty);
  fm.on('deezer.test/search/track', () => ({ data: [{ id: 9, title: 'Something', artist: { name: 'A', id: 1 }, album: { id: 2 }, duration: 100 }] }));
  fm.on('musicbrainz.test', () => { mbCalls++; return { releases: [], recordings: [] }; });

  const r = await req(srv.url, 'GET', '/api/search?q=something');
  assert.equal(mbCalls, 0);
  assert.equal(r.body.tracks[0].source, 'deezer');
});

test('the fallback stays off until it is switched on', async () => {
  setSetting('musicbrainz_fallback_enabled', '0');
  fm.on('deezer.test/search/', empty);
  // No MusicBrainz route: reaching for it would throw in the mock.
  const r = await req(srv.url, 'GET', '/api/search?q=nothing');
  assert.deepEqual(r.body, { artists: [], albums: [], tracks: [] });
});

test('a MusicBrainz outage leaves the empty Deezer result as it was', async () => {
  fm.on('deezer.test/search/', empty);
  fm.on('musicbrainz.test', () => { throw new Error('connection reset'); });
  const r = await req(srv.url, 'GET', '/api/search?q=werenoi');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { artists: [], albums: [], tracks: [] });
});

test('search results report what is already on disk, whichever catalog they came from', async () => {
  const trackId = mbLocalId('rec-aaaa', 'recording');
  const albumId = mbLocalId('rel-cccc', 'release');
  addTrack({ deezer_id: trackId, album_id: albumId, file_path: '/lib/have.flac' });

  fm.on('deezer.test/search/', empty);
  fm.on('musicbrainz.test', () => ({ releases: [RELEASE], recordings: [RECORDING] }));
  const r = await req(srv.url, 'GET', '/api/search?q=werenoi');
  assert.equal(r.body.tracks.find(t => t.id === trackId).available, true);
  assert.equal(r.body.albums.find(a => a.id === albumId).available, true);
});

/* ------------------------------------------------------------- the album */
test('the album page serves a MusicBrainz release like any other', async () => {
  fm.on('musicbrainz.test', () => RELEASE);
  const id = mbLocalId('rel-cccc', 'release');
  const r = await req(srv.url, 'GET', `/api/album/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'Pyramide');
  assert.equal(r.body.source, 'musicbrainz');
  assert.equal(r.body.tracks.length, 2);
  assert.equal(r.body.tracks[0].source, 'musicbrainz');
  assert.equal(r.body.tracks[0].artist, 'Werenoi');
});

/* ----------------------------------------------------------- no previews */
test('a MusicBrainz track has no preview, and says why', async () => {
  const id = mbLocalId('rec-aaaa', 'recording');
  const r = await req(srv.url, 'GET', `/api/preview/${id}`);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /MusicBrainz, which has no audio/);
});

/* ------------------------------------------------------------- download */
test('a MusicBrainz release can be queued for download', async () => {
  fm.on('musicbrainz.test', () => RELEASE);
  const id = mbLocalId('rel-cccc', 'release');
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { r.user = { id: user.id, username: 'u', is_admin: 0 }; next(); });
  const { api } = await import('../api.js');
  app.use('/api', api);
  const s2 = await listen(app);
  try {
    const r = await req(s2.url, 'POST', '/api/download', { body: { kind: 'album', deezer_id: id } });
    assert.equal(r.status, 200);
    const dl = db.prepare('SELECT * FROM downloads WHERE deezer_id = ?').get(id);
    assert.equal(dl.kind, 'album');
    // The label is built from MusicBrainz metadata, same as it would be from Deezer.
    assert.match(dl.label, /Werenoi – Pyramide/);
  } finally { await s2.close(); }
});
