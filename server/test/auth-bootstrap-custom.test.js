import './helpers/env-admin-custom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { bootstrapAdmin } from '../auth.js';
import { db } from '../db.js';

test('bootstrapAdmin with an explicit strong seed does not force a change', () => {
  const log = console.log; console.log = () => {};
  try { bootstrapAdmin(); } finally { console.log = log; }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  assert.equal(u.must_change_password, 0);
  assert.ok(bcrypt.compareSync('Str0ngSeed!', u.password_hash));
});
