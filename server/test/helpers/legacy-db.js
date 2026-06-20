// Side-effect: stand up a pre-rename, pre-migration database so importing db.js
// exercises the tonearr.db -> musicarr.db rename and every ALTER-TABLE migration.
// Import this BEFORE ../db.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicarr-legacy-'));
process.env.DATA_DIR = dir;
process.env.MUSIC_DIR = path.join(dir, 'music');
process.env.SLSKD_DOWNLOAD_DIR = path.join(dir, 'dl');
process.env.LOG_LEVEL = 'error';
export const dataDir = dir;

const legacy = path.join(dir, 'tonearr.db');
const d = new Database(legacy);
// Old schema: tables exist but lack every column added by later migrations.
d.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT);
  CREATE TABLE tracks (deezer_id INTEGER PRIMARY KEY, title TEXT, artist TEXT, artist_id INTEGER,
    album TEXT, album_id INTEGER, track_position INTEGER, duration INTEGER, cover TEXT, file_path TEXT, added_at TEXT);
  CREATE TABLE downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, deezer_id INTEGER,
    label TEXT, cover TEXT, release_title TEXT, torrent_hash TEXT, status TEXT DEFAULT 'searching',
    detail TEXT, progress REAL DEFAULT 0, created_at TEXT, updated_at TEXT);
  INSERT INTO tracks (deezer_id, title, artist, file_path) VALUES (1, 'T', 'A', '/x.flac');
`);
d.close();
// Sidecar files so the rename loop moves the -wal/-shm variants too.
fs.writeFileSync(legacy + '-wal', '');
fs.writeFileSync(legacy + '-shm', '');
