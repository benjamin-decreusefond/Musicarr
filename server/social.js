import { Router } from 'express';
import { db, avatarUrl } from './db.js';

// Social features for users of the same server: search/follow people and see
// what they like and are listening to. Visibility is open within the server.
export const socialRouter = Router();

// A user's live "now playing" track, if the heartbeat is fresh (< 60s).
const nowPlayingStmt = db.prepare(`
  SELECT t.deezer_id AS id, t.title, t.artist, t.artist_id, t.album, t.album_id, t.cover,
         (t.file_path IS NOT NULL) AS available, np.updated_at
  FROM now_playing np JOIN tracks t ON t.deezer_id = np.track_id
  WHERE np.user_id = ? AND np.track_id IS NOT NULL
    AND np.updated_at > datetime('now', '-60 seconds')
`);
const nowPlayingOf = (userId) => nowPlayingStmt.get(userId) || null;

function userCard(u, viewerId) {
  return {
    id: u.id,
    username: u.username,
    is_admin: !!u.is_admin,
    following: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(viewerId, u.id),
    followers: db.prepare('SELECT COUNT(*) AS n FROM follows WHERE following_id = ?').get(u.id).n,
    nowPlaying: nowPlayingOf(u.id),
    avatar: avatarUrl(u.id),
  };
}

// Heartbeat: the player calls this every ~20s with the active track so others
// can see what you're listening to in real time.
socialRouter.post('/heartbeat', (req, res) => {
  const trackId = parseInt(req.body?.track_id, 10);
  db.prepare(`
    INSERT INTO now_playing (user_id, track_id, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET track_id = excluded.track_id, updated_at = excluded.updated_at
  `).run(req.user.id, Number.isFinite(trackId) ? trackId : null);
  res.json({ ok: true });
});

// Search / list other users (most-followed first when no query).
socialRouter.get('/users', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const rows = q
    ? db.prepare(`SELECT id, username, is_admin FROM users WHERE id != ? AND username LIKE ? ORDER BY username LIMIT 50`)
        .all(req.user.id, `%${q}%`)
    : db.prepare(`
        SELECT u.id, u.username, u.is_admin FROM users u WHERE u.id != ?
        ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) DESC, u.username LIMIT 50`)
        .all(req.user.id);
  res.json(rows.map(u => userCard(u, req.user.id)));
});

// People you follow, with their live now-playing and last-played track.
socialRouter.get('/following', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.is_admin FROM follows f
    JOIN users u ON u.id = f.following_id WHERE f.follower_id = ? ORDER BY u.username
  `).all(req.user.id);
  const lastPlayed = db.prepare(`
    SELECT t.deezer_id AS id, t.title, t.artist, t.album_id, t.cover, MAX(p.played_at) AS at
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id WHERE p.user_id = ?
    GROUP BY p.track_id ORDER BY at DESC LIMIT 1`);
  res.json(rows.map(u => ({ ...userCard(u, req.user.id), lastPlayed: lastPlayed.get(u.id) || null })));
});

socialRouter.post('/follow/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'User not found' });
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ ok: true });
});

socialRouter.delete('/follow/:id', (req, res) => {
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// A user's public profile: now-playing, recently played, liked songs.
socialRouter.get('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const recent = db.prepare(`
    SELECT t.deezer_id, t.title, t.artist, t.artist_id, t.album, t.album_id, t.duration, t.cover,
           (t.file_path IS NOT NULL) AS available, t.in_library, MAX(p.played_at) AS last_played
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id WHERE p.user_id = ?
    GROUP BY p.track_id ORDER BY last_played DESC LIMIT 30`).all(id);
  const favorites = db.prepare(`
    SELECT t.deezer_id, t.title, t.artist, t.artist_id, t.album, t.album_id, t.duration, t.cover,
           (t.file_path IS NOT NULL) AS available, t.in_library
    FROM favorites f JOIN tracks t ON t.deezer_id = f.track_id WHERE f.user_id = ?
    ORDER BY f.added_at DESC LIMIT 50`).all(id);
  const playlists = db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at').all(id);
  for (const l of playlists) {
    l.count = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(l.id).n;
    l.cover = db.prepare(`
      SELECT t.cover FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
      WHERE pi.playlist_id = ? AND t.cover IS NOT NULL ORDER BY pi.position LIMIT 1`).get(l.id)?.cover || null;
  }
  res.json({
    ...userCard(u, req.user.id),
    following_count: db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').get(id).n,
    recent, favorites, playlists,
  });
});
