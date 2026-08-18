import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setSetting, db } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import { addTrack, wipe } from './helpers/seed.js';
import { mbGet, byIsrc, bySearch, enrichTrack, fieldsFromRecording, resetMusicbrainz } from '../musicbrainz.js';

// A recording as MusicBrainz returns it, trimmed to the fields we read.
const RECORDING = {
  id: 'rec-1111',
  'artist-credit': [{ artist: { id: 'art-2222', name: 'The Sound' } }],
  releases: [
    { id: 'rel-late', date: '2011-05-02', title: 'Greatest Hits' },
    { id: 'rel-first', date: '1998-03-14', title: 'First Light' },
  ],
};

beforeEach(() => {
  wipe();
  resetMusicbrainz();
  fm.install();
  setSetting('musicbrainz_enabled', '1');
});
afterEach(() => fm.uninstall());

/* ------------------------------------------------------------- extraction */
test('a recording reduces to its identifiers and its earliest release', () => {
  const f = fieldsFromRecording(RECORDING);
  assert.equal(f.mb_recording_id, 'rec-1111');
  assert.equal(f.mb_artist_id, 'art-2222');
  // The original pressing, not the compilation that reissued it.
  assert.equal(f.mb_release_id, 'rel-first');
  assert.equal(f.release_date, '1998-03-14');
});

test('missing pieces degrade instead of throwing', () => {
  assert.equal(fieldsFromRecording(null), null);
  assert.equal(fieldsFromRecording({}), null);
  // No dated release: fall back to the first one and the recording's own date.
  const f = fieldsFromRecording({ id: 'r', releases: [{ id: 'only' }], 'first-release-date': '2004' });
  assert.equal(f.mb_release_id, 'only');
  assert.equal(f.release_date, '2004');
  assert.equal(f.mb_artist_id, null);
  // No releases at all.
  assert.equal(fieldsFromRecording({ id: 'r' }).mb_release_id, null);
});

/* ---------------------------------------------------------------- lookups */
test('an ISRC lookup is exact, and only a well-formed ISRC is sent', async () => {
  let asked = null;
  fm.on('musicbrainz.test', (url) => { asked = url; return { recordings: [RECORDING] }; });

  const f = await byIsrc('frx123456789');
  assert.equal(f.mb_recording_id, 'rec-1111');
  assert.match(asked, /\/ws\/2\/isrc\/FRX123456789\?/);   // normalized to upper case
  assert.match(asked, /fmt=json/);

  // Anything that isn't an ISRC never reaches the network (fetchmock would throw).
  fm.reset();
  assert.equal(await byIsrc('not-an-isrc'), null);
  assert.equal(await byIsrc(''), null);
  assert.equal(await byIsrc(null), null);
});

test('an unknown ISRC is a plain answer, not an error', async () => {
  fm.on('musicbrainz.test', () => new Response('', { status: 404 }));
  assert.equal(await byIsrc('FRX123456789'), null);
});

test('a server error propagates so the caller can decide', async () => {
  fm.on('musicbrainz.test', () => new Response('busy', { status: 503 }));
  await assert.rejects(mbGet('recording/x'), /MusicBrainz 503/);
});

test('the search fallback refuses weak and wrong-length matches', async () => {
  const hits = (recordings) => { fm.reset(); fm.install(); fm.on('musicbrainz.test', () => ({ recordings })); };

  hits([{ ...RECORDING, score: 100, length: 180000 }]);
  assert.equal((await bySearch({ artist: 'The Sound', title: 'Daylight', duration: 180 })).mb_recording_id, 'rec-1111');

  // Low confidence is not a match.
  resetMusicbrainz();
  hits([{ ...RECORDING, score: 70, length: 180000 }]);
  assert.equal(await bySearch({ artist: 'The Sound', title: 'Daylight', duration: 180 }), null);

  // Right name, wrong length: a different recording (live take, remix, edit).
  resetMusicbrainz();
  hits([{ ...RECORDING, score: 100, length: 400000 }]);
  assert.equal(await bySearch({ artist: 'The Sound', title: 'Daylight', duration: 180 }), null);

  // The first strong candidate of several wins.
  resetMusicbrainz();
  hits([{ id: 'weak', score: 10 }, { ...RECORDING, score: 95, length: 181000 }]);
  assert.equal((await bySearch({ artist: 'The Sound', title: 'Daylight', duration: 180 })).mb_recording_id, 'rec-1111');

  // Nothing to search with.
  assert.equal(await bySearch({ artist: '', title: 'x' }), null);
  assert.equal(await bySearch({ artist: 'x', title: '' }), null);
});

test('quotes in a title cannot break out of the search query', async () => {
  let asked = null;
  fm.on('musicbrainz.test', (url) => { asked = url; return { recordings: [] }; });
  await bySearch({ artist: 'A"B', title: 'C"D' });
  const query = decodeURIComponent(new URL(asked).searchParams.get('query'));
  assert.equal(query, 'recording:"C\\"D" AND artist:"A\\"B"');
});

/* ------------------------------------------------------------- enrichment */
test('enrichTrack stores what it finds on the track', async () => {
  addTrack({ deezer_id: 9001, title: 'Daylight', artist: 'The Sound', isrc: 'FRX123456789' });
  fm.on('musicbrainz.test', () => ({ recordings: [RECORDING] }));

  const found = await enrichTrack({ deezer_id: 9001, title: 'Daylight', artist: 'The Sound', isrc: 'FRX123456789' });
  assert.equal(found.mb_recording_id, 'rec-1111');
  const row = db.prepare('SELECT * FROM tracks WHERE deezer_id = 9001').get();
  assert.equal(row.mb_recording_id, 'rec-1111');
  assert.equal(row.mb_release_id, 'rel-first');
  assert.equal(row.mb_artist_id, 'art-2222');
  assert.equal(row.release_date, '1998-03-14');
});

test('enrichTrack falls back to searching when there is no ISRC', async () => {
  addTrack({ deezer_id: 9002, title: 'Daylight', artist: 'The Sound' });
  const asked = [];
  fm.on('musicbrainz.test', (url) => {
    asked.push(url);
    return { recordings: [{ ...RECORDING, score: 100, length: 180000 }] };
  });

  await enrichTrack({ deezer_id: 9002, title: 'Daylight', artist: 'The Sound', duration: 180, isrc: null });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/ws\/2\/recording\?query=/);
  assert.equal(db.prepare('SELECT mb_recording_id FROM tracks WHERE deezer_id = 9002').get().mb_recording_id, 'rec-1111');
});

test('enrichment does nothing at all while it is switched off', async () => {
  setSetting('musicbrainz_enabled', '0');
  addTrack({ deezer_id: 9003, title: 'X', artist: 'Y', isrc: 'FRX123456789' });
  // No route registered: any outbound call would throw in the mock.
  assert.equal(await enrichTrack({ deezer_id: 9003, title: 'X', artist: 'Y', isrc: 'FRX123456789' }), null);
  assert.equal(db.prepare('SELECT mb_recording_id FROM tracks WHERE deezer_id = 9003').get().mb_recording_id, null);
});

test('a MusicBrainz outage costs metadata, never the import', async () => {
  addTrack({ deezer_id: 9004, title: 'X', artist: 'Y', isrc: 'FRX123456789' });
  fm.on('musicbrainz.test', () => { throw new Error('connection reset'); });
  assert.equal(await enrichTrack({ deezer_id: 9004, title: 'X', artist: 'Y', isrc: 'FRX123456789' }), null);

  // No match anywhere is simply no match.
  resetMusicbrainz(); fm.reset(); fm.install();
  fm.on('musicbrainz.test', () => ({ recordings: [] }));
  assert.equal(await enrichTrack({ deezer_id: 9004, title: 'X', artist: 'Y', isrc: 'FRX123456789' }), null);
});

/* ------------------------------------------------ rate limit and caching */
test('requests are serialized one per interval, as MusicBrainz requires', async () => {
  const at = [];
  fm.on('musicbrainz.test', () => { at.push(Date.now()); return { recordings: [] }; });

  const started = Date.now();
  await Promise.all([mbGet('a'), mbGet('b'), mbGet('c')]);
  assert.equal(at.length, 3);
  // Three requests can't be squeezed into less than two intervals.
  assert.ok(Date.now() - started >= 2 * Number(process.env.MUSICBRAINZ_INTERVAL_MS),
    `three calls took ${Date.now() - started}ms`);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] - at[i - 1] >= Number(process.env.MUSICBRAINZ_INTERVAL_MS) - 5);
  }
});

test('a failed request does not wedge every later one', async () => {
  let n = 0;
  fm.on('musicbrainz.test', () => { if (++n === 1) throw new Error('boom'); return { recordings: [RECORDING] }; });
  await assert.rejects(mbGet('first'), /boom/);
  assert.equal((await mbGet('second')).recordings[0].id, 'rec-1111');
});

test('the same lookup is only asked once', async () => {
  let calls = 0;
  fm.on('musicbrainz.test', () => { calls++; return { recordings: [RECORDING] }; });
  await mbGet('isrc/FRX123456789');
  await mbGet('isrc/FRX123456789');
  assert.equal(calls, 1);
  // A different query is a different question.
  await mbGet('isrc/GBX123456789');
  assert.equal(calls, 2);
});
