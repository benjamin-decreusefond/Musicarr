// An unrecognised LOG_LEVEL falls back to 'info' (covers the `?? LEVELS.info`).
import './helpers/loglevel-invalid.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../log.js';

test('invalid level falls back to info', () => {
  const realOut = process.stdout.write;
  const out = [];
  process.stdout.write = (s) => { out.push(s); return true; };
  try {
    logger('i').info('still shown');
    assert.equal(out.length, 1);
  } finally { process.stdout.write = realOut; }
});
