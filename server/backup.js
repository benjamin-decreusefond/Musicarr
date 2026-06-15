import fs from 'node:fs';
import path from 'node:path';
import { db, config } from './db.js';
import { logger } from './log.js';

const log = logger('backup');

// Nightly online backup of the SQLite database. better-sqlite3's backup() is
// safe to run against a live, WAL-mode database — no need to pause writes — and
// produces a single self-contained .db file (no WAL/SHM sidecars to ship).
//
// The DB holds the only stateful data that isn't reproducible from disk: users,
// playlists, favorites, listening history and API tokens. The audio files in the
// root folder are not backed up here (they're large and re-downloadable).
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION = Math.max(1, parseInt(process.env.BACKUP_RETENTION || '7', 10) || 7);

const backupDir = () => path.join(config.dataDir, 'backups');

export async function runBackup() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD — one file per day
  const dest = path.join(dir, `musicarr-${day}.db`);
  await db.backup(dest);
  prune(dir);
  log.info(`database backed up to ${dest}`);
}

function prune(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => /^musicarr-.*\.db$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(RETENTION)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
  }
}

export function startBackups() {
  if (process.env.BACKUP_ENABLED === 'false') {
    log.info('database backups disabled (BACKUP_ENABLED=false)');
    return;
  }
  runBackup().catch(e => log.error('initial backup failed', e));
  setInterval(() => runBackup().catch(e => log.error('backup failed', e)), BACKUP_INTERVAL_MS).unref?.();
}
