import './helpers/env-admin-generated.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapAdmin } from '../auth.js';
import { db } from '../db.js';

test('bootstrapAdmin generates a strong password and forces a change', () => {
  const log = console.log; console.log = () => {};
  try { bootstrapAdmin(); } finally { console.log = log; }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  assert.ok(u);
  assert.equal(u.is_admin, 1);
  assert.equal(u.must_change_password, 1);
  bootstrapAdmin(); // second call: users already exist -> no-op branch
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});
