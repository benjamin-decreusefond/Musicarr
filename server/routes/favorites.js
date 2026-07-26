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

api.get('/offline', (req, res) => {
  // `available` lets a client tell "pinned and downloadable" from "pinned but
  // the server no longer has the audio", without a second round trip.
  res.json(db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, ok.created_at AS pinned_at
    FROM offline_keeps ok JOIN tracks t ON t.deezer_id = ok.track_id
    WHERE ok.user_id = ? ORDER BY ok.created_at DESC
  `).all(req.user.id));
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
