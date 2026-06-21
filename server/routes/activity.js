import { db } from '../db.js';
export function registerActivity(api) {
api.post('/plays', (req, res) => {
  const id = parseInt(req.body?.track_id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'track_id required' });
  // Only log known tracks, and de-dupe rapid repeats (also prevents a client
  // from spamming this endpoint to grow the plays table without bound).
  if (db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id)) {
    const recent = db.prepare(
      `SELECT 1 FROM plays WHERE user_id = ? AND track_id = ? AND played_at > datetime('now','-30 seconds')`
    ).get(req.user.id, id);
    if (!recent) db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(req.user.id, id);
  }
  res.json({ ok: true });
});

// Recently played, most-recent-first, de-duplicated by track.
api.get('/history', (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, MAX(p.played_at) AS last_played
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE p.user_id = ?
    GROUP BY p.track_id ORDER BY last_played DESC LIMIT 30
  `).all(req.user.id));
});

/* --------------------------------------------------- Playback preferences */
// Per-user playback settings (volume, equalizer, repeat mode) live on the
// server so they sync across all of a user's clients. The browser still keeps a
// localStorage copy as an instant/offline cache; this is the source of truth.
const REPEAT_MODES = new Set(['off', 'all', 'one']);

// Coerce an arbitrary client-supplied object into a clean, validated subset.
// Unknown keys are dropped; bad values are simply omitted (not stored).
function sanitizePrefs(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if ('volume' in input) {
    const v = Number(input.volume);
    if (Number.isFinite(v)) out.volume = Math.min(1, Math.max(0, v));
  }
  if ('eqEnabled' in input) out.eqEnabled = !!input.eqEnabled;
  if ('eqGains' in input && Array.isArray(input.eqGains)) {
    const g = input.eqGains.map(Number);
    if (g.every(Number.isFinite)) out.eqGains = g;
  }
  if ('repeat' in input && REPEAT_MODES.has(input.repeat)) out.repeat = input.repeat;
  return out;
}

function readPrefs(userId) {
  const row = db.prepare('SELECT data FROM user_prefs WHERE user_id = ?').get(userId);
  if (!row) return {};
  try { const obj = JSON.parse(row.data); return obj && typeof obj === 'object' ? obj : {}; }
  catch { return {}; }
}

api.get('/preferences', (req, res) => {
  res.json(readPrefs(req.user.id));
});

api.put('/preferences', (req, res) => {
  // Merge the (validated) partial into whatever is already stored so keys the
  // client didn't send are preserved.
  const merged = { ...readPrefs(req.user.id), ...sanitizePrefs(req.body) };
  db.prepare(`
    INSERT INTO user_prefs (user_id, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify(merged));
  res.json(merged);
});

/* ------------------------------------------------------- Listening stats */
// A personal "Wrapped"-style dashboard computed from the user's play history.
// `range` selects the window: 'month' (30d), 'year' (365d) or 'all' (default).
const STATS_WINDOWS = { week: '-7 days', month: '-30 days', year: '-365 days' };
api.get('/stats', (req, res) => {
  // Optionally view another user's stats (?user=:id). Profiles are public to any
  // signed-in user (same as /api/social/users/:id), so no extra gate is needed.
  const requested = parseInt(req.query.user, 10);
  let userId = req.user.id;
  let username = null;
  if (Number.isFinite(requested) && requested !== req.user.id) {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(requested);
    if (!u) return res.status(404).json({ error: 'User not found' });
    userId = u.id;
    username = u.username;
  }
  const rangeKey = STATS_WINDOWS[req.query.range] ? req.query.range : 'all';
  // A SQL WHERE fragment + bound args for the selected window.
  const since = STATS_WINDOWS[rangeKey];
  const where = since ? `p.user_id = ? AND p.played_at > datetime('now', ?)` : `p.user_id = ?`;
  const args = since ? [userId, since] : [userId];

  const totals = db.prepare(`
    SELECT COUNT(*) AS plays,
           COUNT(DISTINCT p.track_id) AS tracks,
           COUNT(DISTINCT t.artist_id) AS artists,
           COALESCE(SUM(t.duration), 0) AS seconds
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where}
  `).get(...args);

  const topArtists = db.prepare(`
    SELECT t.artist_id, t.artist, COUNT(*) AS plays, MAX(t.cover) AS cover
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where} AND t.artist_id IS NOT NULL
    GROUP BY t.artist_id ORDER BY plays DESC, t.artist LIMIT 12
  `).all(...args);

  const topTracks = db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where}
    GROUP BY p.track_id ORDER BY plays DESC, MAX(p.played_at) DESC LIMIT 15
  `).all(...args);

  const topAlbums = db.prepare(`
    SELECT t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist,
           MAX(t.cover) AS cover, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where} AND t.album_id IS NOT NULL
    GROUP BY t.album_id ORDER BY plays DESC LIMIT 8
  `).all(...args);

  // Per-day play counts for the last 14 days, for a small activity sparkline.
  const daily = db.prepare(`
    SELECT date(p.played_at) AS day, COUNT(*) AS plays
    FROM plays p
    WHERE p.user_id = ? AND p.played_at > datetime('now','-14 days')
    GROUP BY day ORDER BY day
  `).all(userId);

  res.json({ range: rangeKey, username, totals, topArtists, topTracks, topAlbums, daily });
});

}
