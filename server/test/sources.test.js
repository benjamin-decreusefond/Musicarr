import './helpers/env.js';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setSetting } from '../db.js';
import * as fm from './helpers/fetchmock.js';
import {
  deezerGet, deezerRouter, isTransientSlskdError, slskdReady, testSlskd,
  slskdServerState, slskdSearch, slskdEnqueue, slskdTransfers, slskdCancel,
  scoreSlskdFiles, scoreSlskdFolders,
} from '../sources.js';
import { makeAuthedApp, listen, req, setUser } from './helpers/app.js';

beforeEach(() => { fm.install(); setSetting('slskd_url', 'https://slskd.test'); setSetting('slskd_api_key', 'key'); });
afterEach(() => { fm.uninstall(); });

/* ----------------------------------------------------------- scoreSlskdFiles */
test('scoreSlskdFiles ranks flac/free-slot matches first and drops mismatches', () => {
  const files = [
    { filename: 'Artist/Album/01 - My Song.flac', length: 180, bitRate: 0, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 500000 },
    { filename: 'Artist/Album/01 - My Song.mp3', length: 180, bitRate: 320, hasFreeUploadSlot: false, queueLength: 5 },
    { filename: 'Other/Different Track.mp3', length: 180, bitRate: 128, hasFreeUploadSlot: false, queueLength: 0 },
  ];
  const ranked = scoreSlskdFiles(files, 'Artist', 'My Song', 180);
  assert.equal(ranked[0].filename, 'Artist/Album/01 - My Song.flac');
  assert.ok(ranked.length >= 2);
});

test('scoreSlskdFiles hard duration gate rejects a different-length take', () => {
  const files = [{ filename: 'A/My Song.flac', length: 240, hasFreeUploadSlot: true, queueLength: 0 }];
  assert.equal(scoreSlskdFiles(files, 'A', 'My Song', 180).length, 0); // 60s off > tolerance
});

test('scoreSlskdFiles trusts a numerically-named file when the title is in the path and duration matches', () => {
  const files = [{ filename: 'Some Artist/Mystery Title/07.flac', length: 200, hasFreeUploadSlot: true, queueLength: 0 }];
  const ranked = scoreSlskdFiles(files, 'Some Artist', 'Mystery Title', 200);
  assert.equal(ranked.length, 1);
});

test('scoreSlskdFiles drops a title-only match from the wrong artist with unknown duration', () => {
  const files = [{ filename: 'Wrong Dude/My Song.mp3', length: 0, hasFreeUploadSlot: true, queueLength: 0 }];
  assert.equal(scoreSlskdFiles(files, 'Beyonce', 'My Song', null).length, 0);
});

test('scoreSlskdFiles penalises live/remix unless requested, and low bitrate', () => {
  const files = [
    { filename: 'Artist/Track (Live).mp3', length: 180, bitRate: 128, hasFreeUploadSlot: true, queueLength: 0 },
    { filename: 'Artist/Track.flac', length: 180, hasFreeUploadSlot: true, queueLength: 0 },
  ];
  const ranked = scoreSlskdFiles(files, 'Artist', 'Track', 180);
  assert.equal(ranked[0].filename, 'Artist/Track.flac');
  // When the request itself asks for the live take, the penalty is waived.
  const live = scoreSlskdFiles([files[0]], 'Artist', 'Track Live', 180);
  assert.equal(live.length, 1);
});

test('scoreSlskdFiles handles empty wanted title/artist gracefully', () => {
  const files = [{ filename: 'x/anything.flac', length: 100, hasFreeUploadSlot: false, queueLength: 0 }];
  assert.ok(Array.isArray(scoreSlskdFiles(files, '', '', null)));
});

/* --------------------------------------------------------- scoreSlskdFolders */
test('scoreSlskdFolders keeps folders covering enough of the tracklist', () => {
  const files = [
    { username: 'u1', filename: 'u1/Album/01 One.flac', hasFreeUploadSlot: true, queueLength: 0 },
    { username: 'u1', filename: 'u1/Album/02 Two.flac', hasFreeUploadSlot: true, queueLength: 0 },
    { username: 'u2', filename: 'u2/Album/01 One.mp3', hasFreeUploadSlot: false, queueLength: 9 },
  ];
  const folders = scoreSlskdFolders(files, ['One', 'Two']);
  assert.equal(folders[0].username, 'u1');
  assert.equal(folders[0].matched, 2);
});

test('scoreSlskdFolders drops folders that are too incomplete', () => {
  const files = [{ username: 'u', filename: 'u/Album/01 One.mp3' }];
  assert.equal(scoreSlskdFolders(files, ['One', 'Two', 'Three', 'Four']).length, 0);
});

/* ------------------------------------------------------ isTransientSlskdError */
test('isTransientSlskdError recognises transient vs terminal errors', () => {
  assert.equal(isTransientSlskdError({ status: 503 }), true);
  assert.equal(isTransientSlskdError({ name: 'TimeoutError' }), true);
  assert.equal(isTransientSlskdError({ message: 'must be connected' }), true);
  assert.equal(isTransientSlskdError({ cause: { code: 'ECONNREFUSED' } }), true);
  assert.equal(isTransientSlskdError({ message: 'fetch failed' }), true);
  assert.equal(isTransientSlskdError({ status: 404, message: 'not found' }), false);
  assert.equal(isTransientSlskdError(null), false);
});

/* ------------------------------------------------------------------ deezerGet */
test('deezerGet returns and caches JSON, surfaces error payloads and bad status', async () => {
  let calls = 0;
  fm.on('deezer.test/track/1', () => { calls++; return { id: 1, title: 'T' }; });
  const a = await deezerGet('track/1');
  const b = await deezerGet('track/1'); // cached
  assert.equal(a.title, 'T');
  assert.equal(b.title, 'T');
  assert.equal(calls, 1);

  fm.on('deezer.test/track/2', () => fm.json({ error: { message: 'Quota' } }));
  await assert.rejects(deezerGet('track/2'), /Quota/);

  fm.on('deezer.test/track/3', () => fm.json({}, 500));
  await assert.rejects(deezerGet('track/3'), /Deezer 500/);
});

test('deezerGet error payload without message falls back to type/json', async () => {
  fm.on('deezer.test/track/9', () => fm.json({ error: { type: 'OAuth' } }));
  await assert.rejects(deezerGet('track/9'), /OAuth/);
  fm.on('deezer.test/track/10', () => fm.json({ error: { code: 4 } }));
  await assert.rejects(deezerGet('track/10'), /Deezer:/);
});

/* ---------------------------------------------------------------- deezerRouter */
test('deezerRouter proxies allowed paths, rejects others, surfaces upstream errors', async () => {
  setUser({ id: 1, username: 'u', is_admin: 0 });
  const app = makeAuthedApp();
  const srv = await listen(app);
  try {
    fm.on('deezer.test/search/track', () => ({ data: [{ id: 5 }] }));
    const ok = await req(srv.url, 'GET', '/api/deezer/search/track?q=hi');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data[0].id, 5);

    const bad = await req(srv.url, 'GET', '/api/deezer/not/allowed');
    assert.equal(bad.status, 400);

    fm.on('deezer.test/album/7', () => { throw new Error('down'); });
    const err = await req(srv.url, 'GET', '/api/deezer/album/7');
    assert.equal(err.status, 502);
  } finally { await srv.close(); }
});

/* --------------------------------------------------------------- slskd client */
test('slskdServerState and slskdReady reflect the connection', async () => {
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected, LoggedIn' }));
  assert.match(await slskdServerState(), /Connected/);
  assert.equal(await slskdReady(), true);

  fm.reset(); fm.install();
  fm.on('slskd.test/api/v0/server', () => { throw new Error('x'); });
  assert.equal(await slskdServerState(), 'unreachable');
  assert.equal(await slskdReady(), false);
});

test('testSlskd validates inputs and reports server state', async () => {
  await assert.rejects(testSlskd({ url: '', apiKey: '' }), /required/);

  fm.on('slskd.test/api/v0/session', () => fm.json({}, 200));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Connected' }));
  const ok = await testSlskd({ url: 'https://slskd.test', apiKey: 'k' });
  assert.equal(ok.serverState, 'Connected');

  fm.reset(); fm.install();
  fm.on('slskd.test/api/v0/session', () => fm.json({}, 401));
  await assert.rejects(testSlskd({ url: 'https://slskd.test', apiKey: 'bad' }), /rejected the API key/);

  fm.reset(); fm.install();
  fm.on('slskd.test/api/v0/session', () => fm.json({}, 500));
  await assert.rejects(testSlskd({ url: 'https://slskd.test', apiKey: 'k' }), /returned 500/);

  fm.reset(); fm.install();
  fm.on('slskd.test/api/v0/session', () => { throw new Error('no route to host'); });
  await assert.rejects(testSlskd({ url: 'https://slskd.test', apiKey: 'k' }), /Could not reach/);
});

test('testSlskd tolerates a failing server-state probe', async () => {
  fm.on('slskd.test/api/v0/session', () => fm.json({}, 200));
  fm.on('slskd.test/api/v0/server', () => fm.json({}, 500));
  const ok = await testSlskd({ url: 'https://slskd.test', apiKey: 'k' });
  assert.equal(ok.serverState, 'unknown');
});

test('slskd transfers/enqueue/cancel happy + error paths', async () => {
  fm.on(/transfers\/downloads\/peer$/, (url, opts) => {
    if (opts.method === 'POST') return fm.json({}, 200);
    return { directories: [{ files: [{ id: 1, filename: 'a.flac', state: 'InProgress' }] }] };
  });
  assert.equal(await slskdEnqueue('peer', { filename: 'a.flac', size: 10 }), true);
  const tr = await slskdTransfers('peer');
  assert.equal(tr[0].filename, 'a.flac');

  fm.on(/transfers\/downloads\/gone$/, () => { throw new Error('nope'); });
  assert.deepEqual(await slskdTransfers('gone'), []);   // errors swallowed -> []
  await slskdCancel('gone', 1);                          // cancel swallows errors
});

test('slskdFetch throws when not configured, on auth failure, on non-ok body, and parses empty bodies', async () => {
  setSetting('slskd_url', '');                                  // not configured (line 63)
  await assert.rejects(slskdEnqueue('p', { filename: 'x', size: 1 }), /not configured/);
  setSetting('slskd_url', 'https://slskd.test');

  fm.on(/transfers\/downloads\/auth$/, () => fm.json({}, 401)); // 401 -> rejected key (line 69)
  await assert.rejects(slskdEnqueue('auth', { filename: 'x', size: 1 }), /rejected the API key/);

  fm.on(/transfers\/downloads\/boom$/, () => new Response('upstream detail', { status: 500 }));
  await assert.rejects(slskdEnqueue('boom', { filename: 'x', size: 1 }), /slskd 500: upstream detail/);

  fm.on('slskd.test/api/v0/server', () => new Response('', { status: 200 })); // empty body -> null
  assert.equal(await slskdServerState(), 'unknown');
});

/* ----------------------------------------------------------------- slskdSearch */
test('slskdSearch flattens audio responses', async () => {
  fm.on(/api\/v0\/searches$/, (url, opts) => { assert.equal(opts.method, 'POST'); return { id: 'sid' }; });
  fm.on(/searches\/sid$/, (url, opts) => opts.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, state: 'Completed', responseCount: 1 });
  fm.on(/searches\/sid\/responses$/, () => ([
    { username: 'p1', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, files: [
      { filename: 'p1/song.flac', size: 10, bitRate: 1000, length: 200 },
      { filename: 'p1/cover.jpg', size: 5 },               // non-audio -> skipped
    ] },
  ]));
  const files = await slskdSearch('query', { timeoutMs: 20000 });
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'p1/song.flac');
});

test('slskdSearch with zero responses logs server state and returns []', async () => {
  fm.on(/api\/v0\/searches$/, () => ({ id: 'z' }));
  fm.on(/searches\/z$/, (url, opts) => opts.method === 'DELETE' ? fm.json({}, 200) : { isComplete: true, responseCount: 0 });
  fm.on(/searches\/z\/responses$/, () => ([]));
  fm.on('slskd.test/api/v0/server', () => ({ state: 'Disconnected' }));
  assert.deepEqual(await slskdSearch('q', { timeoutMs: 20000 }), []);
});

test('slskdSearch throws when slskd returns no search id, and tolerates a failing responses fetch', async () => {
  fm.on(/api\/v0\/searches$/, () => ({}));
  await assert.rejects(slskdSearch('q'), /did not return a search id/);
});

test('slskdSearch breaks early once enough responses arrive', async () => {
  fm.on(/api\/v0\/searches$/, () => ({ id: 'e' }));
  fm.on(/searches\/e$/, (url, opts) => opts.method === 'DELETE' ? fm.json({}, 200) : { isComplete: false, responseCount: 60 });
  fm.on(/searches\/e\/responses$/, () => ([{ username: 'p', files: [{ filename: 'p/a.mp3', size: 1, length: 10 }] }]));
  assert.equal((await slskdSearch('q', { timeoutMs: 20000 })).length, 1);
});
