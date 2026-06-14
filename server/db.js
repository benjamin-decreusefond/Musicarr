import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Initial defaults from the environment. The slskd/library
// settings below can all be overridden from the UI (stored in the settings
// table); these env vars only seed the first-run defaults.
const envDefaults = {
  musicDir: process.env.MUSIC_DIR || '/music',
  // slskd (Soulseek) is the download engine: it searches the network and
  // transfers files. slskdDownloadDir is where slskd writes completed files,
  // as Musicarr sees it — mount slskd's downloads volume into this container.
  slskdUrl: (process.env.SLSKD_URL || '').replace(/\/$/, ''),
  slskdApiKey: process.env.SLSKD_API_KEY || '',
  slskdDownloadDir: process.env.SLSKD_DOWNLOAD_DIR || '/slskd-downloads',
};

// A stored value of '' is meaningful (e.g. clearing a key), so only fall back
// to the env default when nothing has been saved (null).
const stored = (key, dflt) => { const v = getSetting(key); return v === null ? dflt : v; };

export const config = {
  port: parseInt(process.env.PORT || '8686', 10),
  dataDir: process.env.DATA_DIR || '/data',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  // Session cookies are marked Secure by default (the app is meant to sit behind
  // TLS). Set COOKIE_SECURE=false only for a plain-HTTP/LAN deployment.
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  sessionTtlDays: parseInt(process.env.SESSION_TTL_DAYS || '90', 10),
  // Cap how many downloads actively search/transfer at once so a big playlist
  // import doesn't stampede slskd or the event loop.
  maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
  // How often to re-scan for completed-but-unimported downloads.
  sweepIntervalMs: parseInt(process.env.SWEEP_INTERVAL_MS || '600000', 10),
  // A transfer with no progress for this long counts as failed and is retried
  // with the next candidate (Soulseek peers can leave you queued forever).
  slskdStallMs: parseInt(process.env.SLSKD_STALL_MS || '900000', 10),
  envDefaults,

  get musicDir() { return getSetting('root_folder') || envDefaults.musicDir; },
  get slskdUrl() { return stored('slskd_url', envDefaults.slskdUrl).replace(/\/$/, ''); },
  get slskdApiKey() { return stored('slskd_api_key', envDefaults.slskdApiKey); },
  get slskdDownloadDir() { return getSetting('slskd_download_dir') || envDefaults.slskdDownloadDir; },
  get slskdEnabled() { return !!(this.slskdUrl && this.slskdApiKey); },
};

fs.mkdirSync(config.dataDir, { recursive: true });

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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

-- Per-user listening history: powers "recently played", "your top tracks",
-- and seeds personalized recommendations ("you might like").
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL,
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Social graph: who follows whom (all server users can see each other).
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, following_id)
);

-- Live "now playing": refreshed by the player heartbeat; considered active only
-- when updated within the last minute.
CREATE TABLE IF NOT EXISTS now_playing (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_plays_user ON plays(user_id, played_at);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
`);

// Migration: force a password change for the seeded default-credential admin,
// and add it to any pre-existing schema.
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes('must_change_password')) {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
}
// Migration: session expiry (older rows get a TTL lazily on next login).
const sessCols = db.prepare(`PRAGMA table_info(sessions)`).all().map(c => c.name);
if (!sessCols.includes('expires_at')) {
  db.exec(`ALTER TABLE sessions ADD COLUMN expires_at TEXT`);
}
// Migration: remember the exact downloaded source file for each imported track
// so deletion can remove it precisely (the on-disk name can differ from the
// remote/library name, and the download row may be gone).
const trackColsEarly = db.prepare(`PRAGMA table_info(tracks)`).all().map(c => c.name);
if (!trackColsEarly.includes('source_path')) {
  db.exec(`ALTER TABLE tracks ADD COLUMN source_path TEXT`);
}

// Migration: `in_library` distinguishes tracks the user actually requested
// (shown in Library) from tracks that only came along inside an album download
// (shown under "Available"). Existing libraries keep everything they had.
const trackCols = db.prepare(`PRAGMA table_info(tracks)`).all().map(c => c.name);
if (!trackCols.includes('in_library')) {
  db.exec(`ALTER TABLE tracks ADD COLUMN in_library INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE tracks SET in_library = 1 WHERE file_path IS NOT NULL`);
}

// `to_library` = 0 means an import should leave its tracks as "Available"
// rather than promoting the requested track into the Library (playlist imports).
const dlCols = db.prepare(`PRAGMA table_info(downloads)`).all().map(c => c.name);
if (!dlCols.includes('to_library')) {
  db.exec(`ALTER TABLE downloads ADD COLUMN to_library INTEGER NOT NULL DEFAULT 1`);
}
// slskd transfers are identified by the peer username + remote file path(s).
if (!dlCols.includes('engine')) {
  db.exec(`ALTER TABLE downloads ADD COLUMN engine TEXT NOT NULL DEFAULT 'torrent'`);
  db.exec(`ALTER TABLE downloads ADD COLUMN slskd_user TEXT`);
  db.exec(`ALTER TABLE downloads ADD COLUMN slskd_file TEXT`);
}
// Retry bookkeeping: total transfer attempts and a JSON map of
// "<user>|<file>" -> failure count, so retries survive restarts and stop
// re-picking peers that already failed twice.
if (!dlCols.includes('attempts')) {
  db.exec(`ALTER TABLE downloads ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE downloads ADD COLUMN failed_candidates TEXT`);
}

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
