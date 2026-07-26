import { db } from '../db.js';
import { ensureTrack } from './shared.js';
export function registerFavorites(api) {
/* ----------------------------------------------------------- Favorites */
api.get('/favorites', (req, res) => {
  res.json(db.prepare(`
    SELECT t.* FROM favorites f JOIN tracks t ON t.deezer_id = f.track_id
    WHERE f.user_id = ? ORDER BY f.added_at DESC
  `).all(req.user.id));
});


api.put('/favorites/:trackId', (req, res) => {
  const id = ensureTrack(req.params.trackId, req.body);
  if (!id) return res.status(400).json({ error: 'Unknown track — open it once so its details are known, then favorite it' });
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ ok: true });
});

api.delete('/favorites/:trackId', (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?').run(req.user.id, req.params.trackId);
  res.json({ ok: true });
});

/* ------------------------------------------------------ Offline pins */
// Tracks a user wants kept on a device for offline playback. Two jobs:
//   1. tell a (re)installed client what to download, and
//   2. stop auto-cleanup from deleting a file some phone is holding offline
//      (see cleanupStaleTracks — a pin counts alongside favorites/playlists).
// Pinning does NOT itself fetch anything from Soulseek; it only marks intent
// about a track the library already knows.

// The effective set: tracks pinned individually, plus every track of a pinned
// album or playlist. Expanding server-side means a client only ever has to ask
// "what should be on this device?" — it never needs to know that a collection
// was involved, and a song added to a pinned playlist is picked up on the next
// sync without any client logic.
api.get('/offline', (req, res) => {
  // `available` lets a client tell "should be here and downloadable" from
  // "should be here but the server no longer has the audio" — the latter being
  // how it learns to drop a stale local copy — without a second round trip.
  res.json(db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, src.pinned_at, src.source
    FROM (
      SELECT track_id, MIN(created_at) AS pinned_at, MIN(source) AS source FROM (
        SELECT ok.track_id, ok.created_at, 'track' AS source
        FROM offline_keeps ok WHERE ok.user_id = @uid
        UNION ALL
        SELECT pi.track_id, oc.created_at, 'playlist' AS source
        FROM offline_collections oc
        JOIN playlist_items pi ON pi.playlist_id = oc.collection_id
        WHERE oc.user_id = @uid AND oc.kind = 'playlist'
        UNION ALL
        SELECT t2.deezer_id, oc.created_at, 'album' AS source
        FROM offline_collections oc
        JOIN tracks t2 ON t2.album_id = oc.collection_id
        WHERE oc.user_id = @uid AND oc.kind = 'album'
      ) GROUP BY track_id
    ) src
    JOIN tracks t ON t.deezer_id = src.track_id
    ORDER BY src.pinned_at DESC
  `).all({ uid: req.user.id }));
});

/* --------------------------------------------- Offline collections */
// Pinning a whole album or playlist. Stored as the collection, not a snapshot
// of its tracks, so the device keeps following it as it changes.
const COLLECTION_KINDS = new Set(['album', 'playlist']);

api.get('/offline/collections', (req, res) => {
  res.json(db.prepare(
    'SELECT kind, collection_id, created_at FROM offline_collections WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id));
});

api.put('/offline/collections/:kind/:id', (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!COLLECTION_KINDS.has(kind)) return res.status(400).json({ error: 'kind must be album or playlist' });
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid collection id' });
  // A playlist must exist and be visible; an album id is a Deezer id we may not
  // have any local rows for yet (the tracks arrive as they're downloaded), so
  // there's nothing to validate against.
  if (kind === 'playlist' && !db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Playlist not found' });
  }
  db.prepare(
    'INSERT OR IGNORE INTO offline_collections (user_id, kind, collection_id) VALUES (?, ?, ?)'
  ).run(req.user.id, kind, id);
  res.json({ ok: true });
});

api.delete('/offline/collections/:kind/:id', (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!COLLECTION_KINDS.has(kind)) return res.status(400).json({ error: 'kind must be album or playlist' });
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid collection id' });
  db.prepare('DELETE FROM offline_collections WHERE user_id = ? AND kind = ? AND collection_id = ?')
    .run(req.user.id, kind, id);
  res.json({ ok: true });
});

api.put('/offline/:trackId', (req, res) => {
  const id = ensureTrack(req.params.trackId, req.body);
  if (!id) return res.status(400).json({ error: 'Unknown track — open it once so its details are known, then keep it offline' });
  db.prepare('INSERT OR IGNORE INTO offline_keeps (user_id, track_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ ok: true });
});

api.delete('/offline/:trackId', (req, res) => {
  const id = parseInt(req.params.trackId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid track id' });
  db.prepare('DELETE FROM offline_keeps WHERE user_id = ? AND track_id = ?').run(req.user.id, id);
  res.json({ ok: true });
});

}
