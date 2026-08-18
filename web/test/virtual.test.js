import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange, VIRTUALIZE_ABOVE } from '../src/virtual.js';

// 40px rows in a 400px panel: ten rows visible, plus the overscan margin.
const base = { rowHeight: 40, viewportHeight: 400, count: 1000 };

test('at the top of the list, rendering starts at the first row', () => {
  const r = visibleRange({ ...base, scrollTop: 0 });
  assert.equal(r.start, 0);
  assert.equal(r.padTop, 0);
  // Ten visible rows plus overscan on both sides.
  assert.equal(r.end, 30);
  assert.equal(r.padBottom, (1000 - 30) * 40);
});

test('the window follows the scroll position, spacers standing in for the rest', () => {
  const r = visibleRange({ ...base, scrollTop: 4000 });   // 100 rows down
  assert.equal(r.start, 90);                              // 100 - overscan
  assert.equal(r.end, 120);
  assert.equal(r.padTop, 90 * 40);
  assert.equal(r.padBottom, (1000 - 120) * 40);
  // The list always measures its true height, so the scrollbar doesn't jump.
  assert.equal(r.padTop + (r.end - r.start) * 40 + r.padBottom, 1000 * 40);
});

test('scrolling to the very end renders the last rows and nothing beyond', () => {
  const r = visibleRange({ ...base, scrollTop: 1000 * 40 });
  assert.equal(r.end, 1000);
  assert.equal(r.padBottom, 0);
  assert.ok(r.start < r.end);
});

test('a list scrolled out of view above the viewport still starts at row 0', () => {
  // Negative scrollTop means the list hasn't been reached yet.
  const r = visibleRange({ ...base, scrollTop: -800 });
  assert.equal(r.start, 0);
  assert.equal(r.padTop, 0);
});

test('before a row has been measured, everything is rendered', () => {
  const r = visibleRange({ ...base, rowHeight: 0, scrollTop: 0 });
  assert.deepEqual(r, { start: 0, end: 1000, padTop: 0, padBottom: 0 });
  assert.deepEqual(visibleRange({ ...base, rowHeight: -5, scrollTop: 0 }),
    { start: 0, end: 1000, padTop: 0, padBottom: 0 });
});

test('an empty list windows to nothing', () => {
  assert.deepEqual(visibleRange({ ...base, count: 0, scrollTop: 0 }),
    { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test('a viewport of zero height still renders at least one row', () => {
  const r = visibleRange({ ...base, viewportHeight: 0, scrollTop: 0 });
  assert.ok(r.end > r.start);
});

test('the overscan margin is configurable and widens the window symmetrically', () => {
  const none = visibleRange({ ...base, scrollTop: 4000, overscan: 0 });
  assert.equal(none.start, 100);
  assert.equal(none.end, 110);
});

test('short lists are left alone', () => {
  // The threshold is what TrackTable checks before windowing at all; an album
  // or a playlist stays a plain list.
  assert.ok(VIRTUALIZE_ABOVE > 100);
});
