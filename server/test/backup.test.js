import './helpers/env.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../db.js';
import { stubTimers } from './helpers/timers.js';
import { runBackup, startBackups } from '../backup.js';

const backupsDir = () => path.join(config.dataDir, 'backups');
afterEach(() => { delete process.env.BACKUP_ENABLED; });

test('runBackup writes a dated database file and prunes beyond the retention limit', async () => {
  fs.mkdirSync(backupsDir(), { recursive: true });
  // Seed more than the retention (7) of old backups, plus a non-backup file.
  for (let i = 0; i < 9; i++) {
    const f = path.join(backupsDir(), `musicarr-2020-01-0${i}.db`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date(2020, 0, i + 1), new Date(2020, 0, i + 1)); // oldest first
  }
  fs.writeFileSync(path.join(backupsDir(), 'unrelated.txt'), 'keep');

  await runBackup();

  const dbFiles = fs.readdirSync(backupsDir()).filter(f => /^musicarr-.*\.db$/.test(f));
  assert.equal(dbFiles.length, 7);                                   // pruned to retention
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(fs.existsSync(path.join(backupsDir(), `musicarr-${today}.db`)));
  assert.ok(fs.existsSync(path.join(backupsDir(), 'unrelated.txt'))); // non-backups untouched
});

test('startBackups is a no-op when disabled', () => {
  process.env.BACKUP_ENABLED = 'false';
  const t = stubTimers();
  try {
    startBackups();
    assert.equal(t.calls.intervals.length, 0);
  } finally { t.restore(); }
});

test('startBackups runs an initial backup and schedules the interval', async () => {
  const t = stubTimers();
  try {
    startBackups();
    assert.equal(t.calls.intervals.length, 1);
    await t.calls.intervals[0]();   // invoke the scheduled backup callback
  } finally { t.restore(); }
});

test('startBackups swallows a failing initial backup', async () => {
  // Make the backups path a FILE so mkdirSync (and thus runBackup) rejects.
  const dir = backupsDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a directory');
  const t = stubTimers();
  try {
    await assert.rejects(runBackup());          // confirms the failure path
    startBackups();                             // initial backup rejects -> caught
    await t.calls.intervals[0]().catch(() => {}); // interval callback also guarded
  } finally {
    t.restore();
    fs.rmSync(dir, { force: true });
  }
});
