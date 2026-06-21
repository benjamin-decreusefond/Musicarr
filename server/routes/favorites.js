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

}
