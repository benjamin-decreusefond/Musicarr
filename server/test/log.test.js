import './helpers/loglevel-debug.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../log.js';

let out, err, realOut, realErr;
beforeEach(() => {
  out = []; err = [];
  realOut = process.stdout.write; realErr = process.stderr.write;
  process.stdout.write = (s) => { out.push(s); return true; };
  process.stderr.write = (s) => { err.push(s); return true; };
});
afterEach(() => { process.stdout.write = realOut; process.stderr.write = realErr; });

test('routes levels to the right stream and formats the line', () => {
  const log = logger('scope');
  log.info('hello');
  log.debug('dbg');
  log.warn('careful');
  log.error('bad');
  assert.equal(out.length, 2);   // info + debug -> stdout
  assert.equal(err.length, 2);   // warn + error -> stderr
  assert.match(out[0], /INFO {2}\[scope\] hello/);
  assert.match(err[1], /ERROR \[scope\] bad/);
});

test('appends extra: Error stack, string, and JSON object', () => {
  const log = logger('x');
  log.error('failed', new Error('boom'));
  assert.match(err[0], /failed .*(boom|Error)/);

  log.info('msg', 'detail-string');
  assert.match(out[0], /msg detail-string/);

  log.info('obj', { a: 1 });
  assert.match(out[1], /obj \{"a":1\}/);
});

test('an Error with no stack falls back to its message', () => {
  const log = logger('x');
  const e = new Error('only-message');
  e.stack = undefined;
  log.error('e', e);
  assert.match(err[0], /only-message/);
});

test('null/undefined extra is omitted', () => {
  const log = logger('x');
  log.info('plain', null);
  assert.match(out[0], /\[x\] plain\n$/);
});
