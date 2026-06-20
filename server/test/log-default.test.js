// With LOG_LEVEL unset the threshold defaults to 'info': info prints, debug is
// dropped (covers the default fallback and the below-threshold early return).
import './helpers/loglevel-unset.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../log.js';

test('default level prints info but drops debug', () => {
  const realOut = process.stdout.write;
  const out = [];
  process.stdout.write = (s) => { out.push(s); return true; };
  try {
    const log = logger('d');
    log.info('shown');
    log.debug('hidden');
    assert.equal(out.length, 1);
    assert.match(out[0], /INFO {2}\[d\] shown/);
  } finally { process.stdout.write = realOut; }
});
