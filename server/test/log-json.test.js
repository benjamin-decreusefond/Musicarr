import './helpers/logformat-json.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { logger, requestContext, currentRequestId, withRequestId } from '../log.js';
import { listen, req } from './helpers/app.js';

let out, err, realOut, realErr;
const lines = () => [...out, ...err].map(s => JSON.parse(s));

// Capture only our own records and let everything else (the test runner's own
// TAP output, which shares these streams) through: these tests await, so the
// reporter writes while the streams are hooked.
const capture = (bucket, real, stream) => (s, ...rest) => {
  if (typeof s === 'string' && s.startsWith('{"ts":')) { bucket.push(s); return true; }
  return real.call(stream, s, ...rest);
};

beforeEach(() => {
  out = []; err = [];
  realOut = process.stdout.write; realErr = process.stderr.write;
  process.stdout.write = capture(out, realOut, process.stdout);
  process.stderr.write = capture(err, realErr, process.stderr);
});
afterEach(() => { process.stdout.write = realOut; process.stderr.write = realErr; });

test('each record is a single JSON object with the standard fields', () => {
  logger('scope').info('hello');
  const rec = JSON.parse(out[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.scope, 'scope');
  assert.equal(rec.msg, 'hello');
  assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  assert.equal(rec.requestId, undefined);       // nothing to correlate outside a request
  assert.ok(out[0].endsWith('\n') && out[0].split('\n').length === 2);
});

test('extras become fields rather than an appended blob', () => {
  const log = logger('x');
  log.error('failed', new Error('boom'));
  log.info('with object', { downloadId: 7, peer: 'someone' });
  log.info('with string', 'a detail');
  log.info('plain', null);

  const [e] = err.map(JSON.parse);
  assert.equal(e.error, 'boom');
  assert.match(e.stack, /Error: boom/);
  assert.equal(e.msg, 'failed');

  const [obj, str, plain] = out.map(JSON.parse);
  assert.equal(obj.downloadId, 7);
  assert.equal(obj.peer, 'someone');
  assert.equal(str.detail, 'a detail');
  assert.equal(plain.detail, undefined);
});

test('a field named msg cannot displace the message itself', () => {
  logger('x').info('the real message', { msg: 'impostor' });
  assert.equal(JSON.parse(out[0]).msg, 'the real message');
});

test('withRequestId tags everything logged inside it, including after an await', async () => {
  assert.equal(currentRequestId(), null);
  await withRequestId('job-42', async () => {
    logger('a').info('before');
    await new Promise(r => setTimeout(r, 1));
    logger('b').info('after');
    assert.equal(currentRequestId(), 'job-42');
  });
  assert.deepEqual(out.map(s => JSON.parse(s).requestId), ['job-42', 'job-42']);
  assert.equal(currentRequestId(), null);
});

/* --------------------------------------------------------- HTTP requests */
async function serve(handler, { onFinish } = {}) {
  const app = express();
  app.use(requestContext({ onFinish }));
  app.get('/api/thing/:id', handler);
  app.get('/boom', (_req, res) => res.status(500).json({ error: 'no' }));
  return listen(app);
}

test('a request gets an id that its handler logs and the response echoes', async () => {
  const srv = await serve((_req, res) => { logger('handler').info('working'); res.json({ ok: true }); });
  try {
    const r = await req(srv.url, 'GET', '/api/thing/5');
    const id = r.headers.get('x-request-id');
    assert.match(id, /^[0-9a-f]{8}$/);
    const handled = lines().filter(l => l.scope === 'handler');
    assert.equal(handled.length, 1);
    assert.equal(handled[0].requestId, id);
    // ...and the access record for the same request carries it too.
    const access = lines().find(l => l.scope === 'http');
    assert.equal(access.requestId, id);
    assert.equal(access.status, 200);
    assert.equal(access.method, 'GET');
    assert.equal(access.route, '/api/thing/:id');   // the route, not the id
    assert.ok(access.durationMs >= 0);
  } finally { await srv.close(); }
});

test('a caller-supplied request id is honoured, but only if it looks like one', async () => {
  const srv = await serve((_req, res) => res.json({ ok: true }));
  try {
    const good = await req(srv.url, 'GET', '/api/thing/1', { headers: { 'x-request-id': 'edge-7f3a.9' } });
    assert.equal(good.headers.get('x-request-id'), 'edge-7f3a.9');

    // A header with a newline would let a caller forge log records.
    const bad = await req(srv.url, 'GET', '/api/thing/1', { headers: { 'x-request-id': 'abc def' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f]{8}$/);
    const tooLong = await req(srv.url, 'GET', '/api/thing/1', { headers: { 'x-request-id': 'z'.repeat(65) } });
    assert.match(tooLong.headers.get('x-request-id'), /^[0-9a-f]{8}$/);
  } finally { await srv.close(); }
});

test('server errors are logged louder than traffic, and onFinish sees every request', async () => {
  const seen = [];
  const srv = await serve((_req, res) => res.json({ ok: true }), { onFinish: (r) => seen.push(r) });
  try {
    await req(srv.url, 'GET', '/api/thing/1');
    await req(srv.url, 'GET', '/boom');
    assert.deepEqual(seen.map(r => r.status), [200, 500]);
    assert.deepEqual(seen.map(r => r.method), ['GET', 'GET']);
    // The 500 went to stderr (warn); the 200 to stdout (debug).
    assert.equal(err.map(JSON.parse).filter(l => l.scope === 'http').length, 1);
    assert.equal(JSON.parse(err[0]).status, 500);
  } finally { await srv.close(); }
});
