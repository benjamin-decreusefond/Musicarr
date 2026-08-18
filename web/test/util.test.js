import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, sortName, indexLetter, groupByLetter, INDEX_LETTERS, hasPreview, MB_ID_BASE } from '../src/util.js';

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

test('sortName normalises names for alphabetical ordering', () => {
  assert.equal(sortName('The Beatles'), 'beatles');
  assert.equal(sortName('  a Tribe Called Quest'), 'tribe called quest');
  assert.equal(sortName('Björk'), 'bjork');
  assert.equal(sortName('"Weird Al" Yankovic'), 'weird al" yankovic');
  assert.equal(sortName('Los Lobos'), 'lobos');
});

test('sortName keeps the name when stripping would leave nothing', () => {
  assert.equal(sortName('The'), 'the');
  assert.equal(sortName(''), '');
  assert.equal(sortName(null), '');
  assert.equal(sortName(undefined), '');
});

test('indexLetter buckets names into A–Z or #', () => {
  assert.equal(indexLetter('The Beatles'), 'B');
  assert.equal(indexLetter('daft punk'), 'D');
  assert.equal(indexLetter('Édith Piaf'), 'E');
  assert.equal(indexLetter('50 Cent'), '#');
  assert.equal(indexLetter('!!!'), '#');       // punctuation-only name
  assert.equal(indexLetter('Кино'), '#');      // non-latin script
  assert.equal(indexLetter(''), '#');
});

test('groupByLetter orders sections A–Z then #, sorting within each', () => {
  const items = [
    { name: 'Zappa' }, { name: '2Pac' }, { name: 'The Beatles' },
    { name: 'ABBA' }, { name: 'Björk' }, { name: 'A Tribe Called Quest' },
  ];
  const groups = groupByLetter(items);
  assert.deepEqual(groups.map(g => g.letter), ['A', 'B', 'T', 'Z', '#']);
  // "The Beatles" files under B (article ignored) and sorts before "Björk".
  assert.deepEqual(groups.find(g => g.letter === 'B').items.map(i => i.name), ['The Beatles', 'Björk']);
  assert.deepEqual(groups.find(g => g.letter === '#').items.map(i => i.name), ['2Pac']);
});

test('groupByLetter accepts a custom name accessor and empty input', () => {
  const albums = [{ title: 'Kid A' }, { title: 'In Rainbows' }];
  const groups = groupByLetter(albums, (a) => a.title);
  assert.deepEqual(groups.map(g => g.letter), ['I', 'K']);
  assert.deepEqual(groupByLetter([]), []);
  assert.deepEqual(groupByLetter(null), []);
});

test('INDEX_LETTERS covers A–Z plus the # bucket', () => {
  assert.equal(INDEX_LETTERS.length, 27);
  assert.equal(INDEX_LETTERS[0], 'A');
  assert.equal(INDEX_LETTERS[25], 'Z');
  assert.equal(INDEX_LETTERS[26], '#');
});

test('hasPreview hides the 30s clip for MusicBrainz-sourced tracks', () => {
  // Deezer tracks have previews.
  assert.equal(hasPreview({ id: 3135556 }), true);
  assert.equal(hasPreview({ deezer_id: 3135556, source: 'deezer' }), true);
  // MusicBrainz has no audio at all — by source, and by id for the shapes that
  // don't carry one.
  assert.equal(hasPreview({ id: 3135556, source: 'musicbrainz' }), false);
  assert.equal(hasPreview({ id: MB_ID_BASE + 12 }), false);
  assert.equal(hasPreview({ deezer_id: MB_ID_BASE + 12 }), false);
  assert.equal(hasPreview(null), false);
});
