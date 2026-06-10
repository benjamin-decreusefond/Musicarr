import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Initial defaults from the environment. The Jackett/Transmission/library
// settings below can all be overridden from the UI (stored in the settings
// table); these env vars only seed the first-run defaults.
const envDefaults = {
  musicDir: process.env.MUSIC_DIR || '/music',
  // Path of the download dir *as seen by Transmission*. Defaults to the same
  // path: mount the shared volume at the same mount point in both pods.
  transmissionDownloadDir: process.env.TRANSMISSION_DOWNLOAD_DIR || process.env.DOWNLOAD_DIR || '/downloads',
  jackettUrl: (process.env.JACKETT_URL || '').replace(/\/$/, ''),
  jackettApiKey: process.env.JACKETT_API_KEY || '',
  jackettIndexer: process.env.JACKETT_INDEXER || 'all',
  searchCategories: process.env.SEARCH_CATEGORIES || '3000',
  transmissionUrl: process.env.TRANSMISSION_URL || 'http://transmission:9091/transmission/rpc',
  transmissionUser: process.env.TRANSMISSION_USER || '',
  transmissionPass: process.env.TRANSMISSION_PASS || '',
};

// A stored value of '' is meaningful (e.g. clearing Transmission auth), so
// only fall back to the env default when nothing has been saved (null).
const stored = (key, dflt) => { const v = getSetting(key); return v === null ? dflt : v; };

export const config = {
  port: parseInt(process.env.PORT || '8686', 10),
  dataDir: process.env.DATA_DIR || '/data',
  downloadDir: process.env.DOWNLOAD_DIR || '/downloads',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
  envDefaults,

  get musicDir() { return getSetting('root_folder') || envDefaults.musicDir; },
  get transmissionDownloadDir() { return getSetting('transmission_download_dir') || envDefaults.transmissionDownloadDir; },
  get jackettUrl() { return stored('jackett_url', envDefaults.jackettUrl).replace(/\/$/, ''); },
  get jackettApiKey() { return stored('jackett_api_key', envDefaults.jackettApiKey); },
  get jackettIndexer() { return getSetting('jackett_indexer') || envDefaults.jackettIndexer; },
  get searchCategories() {
    return stored('search_categories', envDefaults.searchCategories).split(',').map(s => s.trim()).filter(Boolean);
  },
  get transmissionUrl() { return getSetting('transmission_url') || envDefaults.transmissionUrl; },
  get transmissionUser() { return stored('transmission_user', envDefaults.transmissionUser); },
  get transmissionPass() { return stored('transmission_pass', envDefaults.transmissionPass); },
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.downloadDir, { recursive: true });

// Migrate a pre-rename database (tonearr.db) to the new name in place so
// existing deployments keep their data. Includes the WAL/SHM sidecar files.
const dbPath = path.join(config.dataDir, 'musicarr.db');
const legacyDbPath = path.join(config.dataDir, 'tonearr.db');
if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(legacyDbPath + suffix)) fs.renameSync(legacyDbPath + suffix, dbPath + suffix);
  }
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catalog of known tracks (Deezer metadata). file_path is set once the audio
-- file exists on disk; a single file is shared by every user.
CREATE TABLE IF NOT EXISTS tracks (
  deezer_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artist_id INTEGER,
  album TEXT,
  album_id INTEGER,
  track_position INTEGER,
  duration INTEGER,
  cover TEXT,
  file_path TEXT UNIQUE,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- 'album' | 'track'
  deezer_id INTEGER NOT NULL,      -- album or track id
  label TEXT NOT NULL,             -- human readable "Artist – Title"
  cover TEXT,
  release_title TEXT,              -- title of the chosen indexer release
  torrent_hash TEXT,
  status TEXT NOT NULL DEFAULT 'searching', -- searching|downloading|importing|done|not_found|error
  detail TEXT,
  progress REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(deezer_id),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks(deezer_id),
  PRIMARY KEY (playlist_id, position)
);

CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
`);

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

fs.mkdirSync(config.musicDir, { recursive: true });

/** Insert or refresh a track's catalog metadata without touching file_path. */
export function upsertTrack(t) {
  db.prepare(`
    INSERT INTO tracks (deezer_id, title, artist, artist_id, album, album_id, track_position, duration, cover)
    VALUES (@deezer_id, @title, @artist, @artist_id, @album, @album_id, @track_position, @duration, @cover)
    ON CONFLICT(deezer_id) DO UPDATE SET
      title=excluded.title, artist=excluded.artist, artist_id=excluded.artist_id,
      album=excluded.album, album_id=excluded.album_id,
      track_position=excluded.track_position, duration=excluded.duration, cover=excluded.cover
  `).run(t);
}

export function trackRowFromDeezer(d, albumOverride) {
  const album = albumOverride || d.album || {};
  return {
    deezer_id: d.id,
    title: d.title,
    artist: d.artist?.name || 'Unknown',
    artist_id: d.artist?.id || null,
    album: album.title || null,
    album_id: album.id || null,
    track_position: d.track_position || null,
    duration: d.duration || null,
    cover: album.cover_medium || album.cover || d.album?.cover_medium || null,
  };
}
