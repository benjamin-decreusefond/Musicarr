// Helper to prepare an isolated env (fresh data dir) with an optional seeded
// ADMIN_PASSWORD. Call from a side-effect module BEFORE importing db.js/auth.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function mkenv({ adminPassword } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicarr-boot-'));
  process.env.DATA_DIR = dir;
  process.env.MUSIC_DIR = path.join(dir, 'music');
  process.env.SLSKD_DOWNLOAD_DIR = path.join(dir, 'dl');
  process.env.LOG_LEVEL = 'error';
  if (adminPassword === null) delete process.env.ADMIN_PASSWORD;
  else if (adminPassword !== undefined) process.env.ADMIN_PASSWORD = adminPassword;
  fs.mkdirSync(process.env.MUSIC_DIR, { recursive: true });
  fs.mkdirSync(process.env.SLSKD_DOWNLOAD_DIR, { recursive: true });
}
