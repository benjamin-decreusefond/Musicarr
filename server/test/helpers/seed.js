// Small fixtures for tests: create users, tracks, downloads, etc. directly in
// the DB so route/unit tests start from a known state.

import bcrypt from 'bcryptjs';
import { db, upsertTrack } from '../../db.js';

export { db };

export function createUser({ username = 'user', password = 'password1', is_admin = 0 } = {}) {
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)'
  ).run(username, bcrypt.hashSync(password, 4), is_admin ? 1 : 0);
  return { id: Number(info.lastInsertRowid), username, password, is_admin: !!is_admin };
}

// Insert a track in the catalog. Pass file_path to mark it on-disk/in-library.
export function addTrack(t = {}) {
  const row = {
    deezer_id: t.deezer_id ?? 1,
    title: t.title ?? 'Song',
    artist: t.artist ?? 'Artist',
    artist_id: t.artist_id ?? 100,
    album: t.album ?? 'Album',
    album_id: t.album_id ?? 200,
    track_position: t.track_position ?? 1,
    duration: t.duration ?? 180,
    cover: t.cover ?? 'cover.jpg',
  };
  upsertTrack(row);
  if (t.file_path !== undefined) {
    db.prepare('UPDATE tracks SET file_path = ?, in_library = 1 WHERE deezer_id = ?')
      .run(t.file_path, row.deezer_id);
  }
  if (t.isrc !== undefined) db.prepare('UPDATE tracks SET isrc = ? WHERE deezer_id = ?').run(t.isrc, row.deezer_id);
  return row;
}

// Reset all mutable tables so tests don't leak into one another.
export function wipe() {
  for (const t of ['plays', 'favorites', 'playlist_items', 'playlist_shares', 'playlists',
    'follows', 'followed_artists', 'now_playing', 'downloads', 'tracks', 'seen_artist_albums',
    'listen_members', 'listen_sessions', 'user_prefs', 'api_tokens', 'artists', 'mood_images',
    'peer_strikes', 'sessions', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}
