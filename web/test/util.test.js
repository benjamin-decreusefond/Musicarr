import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime } from '../src/util.js';

test('fmtTime formats seconds as m:ss', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(5), '0:05');
  assert.equal(fmtTime(75), '1:15');
  assert.equal(fmtTime(3661), '61:01');
  assert.equal(fmtTime(42.9), '0:42'); // floors fractional seconds
});

test('fmtTime returns a placeholder for unknown/empty input', () => {
  assert.equal(fmtTime(null), '--:--');
  assert.equal(fmtTime(undefined), '--:--');
  assert.equal(fmtTime(NaN), '--:--');
});
