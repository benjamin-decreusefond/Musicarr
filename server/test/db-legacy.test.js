import { dataDir } from './helpers/legacy-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';

test('renames the legacy database file', () => {
  assert.ok(fs.existsSync(path.join(dataDir, 'musicarr.db')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'tonearr.db')));
});

test('applies every column migration to the pre-existing schema', () => {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  assert.ok(cols('users').includes('must_change_password'));
  assert.ok(cols('sessions').includes('expires_at'));
  for (const c of ['source_path', 'isrc', 'in_library']) assert.ok(cols('tracks').includes(c));
  for (const c of ['to_library', 'engine', 'slskd_user', 'slskd_file', 'attempts', 'failed_candidates']) {
    assert.ok(cols('downloads').includes(c));
  }
  // The in_library backfill marked the existing on-disk track as in-library.
  assert.equal(db.prepare('SELECT in_library FROM tracks WHERE deezer_id = 1').get().in_library, 1);
});
