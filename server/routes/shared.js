import { db, upsertTrack } from '../db.js';

// A track must exist in the catalog before it can be favorited (FK). Search
// results aren't in the catalog yet, so accept the track metadata in the body
// and upsert it first — otherwise the favorite would be silently dropped.
export function ensureTrack(trackId, body) {
  const id = parseInt(trackId, 10);
  if (!Number.isFinite(id)) return null;
  const exists = db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id);
  // The client sends a flat track shape (artist is a string, not a Deezer
  // object), so map it directly rather than via trackRowFromDeezer.
  if (!exists && body && body.title) {
    upsertTrack({
      deezer_id: id,
      title: body.title,
      artist: body.artist || 'Unknown',
      artist_id: body.artist_id || null,
      album: body.album || null,
      album_id: body.album_id || null,
      track_position: body.track_position || null,
      duration: body.duration || null,
      cover: body.cover || null,
    });
  }
  return db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id) ? id : null;
}
