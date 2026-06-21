import fs from 'node:fs';
import { db, upsertTrack, trackRowFromDeezer } from '../db.js';
import { deezerGet } from '../sources.js';
import { queueDownload } from '../downloader.js';
import { rateLimit } from '../ratelimit.js';
import { logger } from '../log.js';
import { ensureTrack } from './shared.js';
export function registerPlaylists(api) {
  const log = logger('api');
  const importLimit = rateLimit({ windowMs: 5 * 60_000, max: 20 });
/* ----------------------------------------------------------- Playlists */
// Fill in a playlist row's track count and a representative cover.
function playlistMeta(l) {
  l.count = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(l.id).n;
  l.cover = db.prepare(`
    SELECT t.cover FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
    WHERE pi.playlist_id = ? AND t.cover IS NOT NULL ORDER BY pi.position LIMIT 1
  `).get(l.id)?.cover || null;
  return l;
}

// Resolve a user's relationship to a playlist: 'owner' | 'editor' | 'viewer',
// or { found:false } when the playlist doesn't exist. Viewing is open within the
// server, so a user with no share is still a 'viewer'.
function playlistRole(playlistId, userId) {
  const l = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!l) return { found: false };
  if (l.user_id === userId) return { found: true, list: l, role: 'owner' };
  const s = db.prepare('SELECT can_edit FROM playlist_shares WHERE playlist_id = ? AND user_id = ?')
    .get(playlistId, userId);
  return { found: true, list: l, role: s ? (s.can_edit ? 'editor' : 'viewer') : 'viewer', shared: !!s };
}
const canEditRole = (role) => role === 'owner' || role === 'editor';

api.get('/playlists', (req, res) => {
  const owned = db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at').all(req.user.id)
    .map(l => ({ ...l, is_owner: true, shared: false }));
  // Playlists other users have shared with me.
  const shared = db.prepare(`
    SELECT p.*, ps.can_edit AS can_edit, ou.username AS owner_name
    FROM playlist_shares ps
    JOIN playlists p ON p.id = ps.playlist_id
    JOIN users ou ON ou.id = p.user_id
    WHERE ps.user_id = ? ORDER BY p.created_at
  `).all(req.user.id).map(l => ({ ...l, is_owner: false, shared: true }));
  res.json([...owned, ...shared].map(playlistMeta));
});

api.post('/playlists', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(req.user.id, name);
  res.json({ id: info.lastInsertRowid, name });
});

// Import a Deezer playlist into the user's collection: create (or refresh) a
// local playlist with the same tracks, then queue downloads for the tracks we
// don't have on disk yet so the playlist becomes fully playable. Missing
// tracks are queued as individual Soulseek downloads.
const IMPORT_QUEUE_CAP = 50; // tracks per run; re-import to continue
api.post('/playlists/import-deezer', importLimit, async (req, res) => {
  const deezerId = parseInt(req.body?.deezer_playlist_id, 10);
  if (!deezerId) return res.status(400).json({ error: 'deezer_playlist_id required' });
  try {
    const pl = await deezerGet(`playlist/${deezerId}`);
    const tracks = (pl.tracks?.data || []).filter(t => t?.id && t?.title);
    if (!tracks.length) return res.status(400).json({ error: 'Playlist has no tracks' });

    const rows = tracks.map(t => trackRowFromDeezer(t));
    rows.forEach(upsertTrack);

    // Reuse a same-named playlist (re-import refreshes it), else create one.
    const name = (pl.title || `Deezer playlist ${deezerId}`).trim();
    let list = db.prepare('SELECT * FROM playlists WHERE user_id = ? AND name = ?').get(req.user.id, name);
    if (!list) {
      const info = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(req.user.id, name);
      list = { id: info.lastInsertRowid, name };
    }
    db.transaction(() => {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(list.id);
      const ins = db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, position, track_id) VALUES (?, ?, ?)');
      rows.forEach((r, i) => ins.run(list.id, i, r.deezer_id));
    })();

    // Queue what's missing — slskd grabs single tracks natively, so each
    // missing song is its own download.
    const haveFile = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    const missing = rows.filter(r => {
      const f = haveFile.get(r.deezer_id)?.file_path;
      return !(f && fs.existsSync(f));
    });
    let queued = 0;
    for (const m of missing) {
      if (queued >= IMPORT_QUEUE_CAP) break;
      queueDownload(req.user.id, 'track', m.deezer_id, `${m.artist} – ${m.title}`, m.cover);
      queued++;
    }
    log.info(`playlist import "${name}": ${rows.length} tracks, ${missing.length} missing, ${queued} download(s) queued`);
    res.json({
      id: list.id, name, total: rows.length,
      have: rows.length - missing.length, missing: missing.length,
      queued, remaining: Math.max(0, missing.length - queued),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

api.get('/playlists/:id', (req, res) => {
  // Any signed-in user can view a playlist (visibility is open within the
  // server). Owners and shared editors can modify it.
  const { found, list, role } = playlistRole(req.params.id, req.user.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  list.is_owner = role === 'owner';
  list.can_edit = canEditRole(role);
  list.role = role;
  list.owner_name = db.prepare('SELECT username FROM users WHERE id = ?').get(list.user_id)?.username || null;
  // Owners get the share list so they can manage it.
  if (role === 'owner') {
    list.shares = db.prepare(`
      SELECT ps.user_id, u.username, ps.can_edit FROM playlist_shares ps
      JOIN users u ON u.id = ps.user_id WHERE ps.playlist_id = ? ORDER BY u.username COLLATE NOCASE
    `).all(list.id);
  }
  list.tracks = db.prepare(`
    SELECT t.*, pi.position FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
    WHERE pi.playlist_id = ? ORDER BY pi.position
  `).all(list.id);
  res.json(list);
});

api.delete('/playlists/:id', (req, res) => {
  // The owner deletes the playlist outright; a recipient "deleting" a playlist
  // shared with them just removes their own share (it leaves their library).
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found) return res.json({ ok: true });
  if (role === 'owner') db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  else db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

api.post('/playlists/:id/tracks', (req, res) => {
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found || !canEditRole(role)) return res.status(found ? 403 : 404).json({ error: found ? 'No edit access' : 'Not found' });
  const trackId = ensureTrack(req.body?.track_id, req.body?.track);
  if (!trackId) return res.status(400).json({ error: 'Unknown track — open it once so its details are known, then add it' });
  const pos = (db.prepare('SELECT MAX(position) AS m FROM playlist_items WHERE playlist_id = ?').get(req.params.id).m ?? -1) + 1;
  db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, position, track_id) VALUES (?, ?, ?)').run(req.params.id, pos, trackId);
  res.json({ ok: true });
});

api.delete('/playlists/:id/tracks/:trackId', (req, res) => {
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found || !canEditRole(role)) return res.status(found ? 403 : 404).json({ error: found ? 'No edit access' : 'Not found' });
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?').run(req.params.id, req.params.trackId);
  res.json({ ok: true });
});

/* ------------------------------------------------ Playlist sharing (collab) */
// Only the owner can manage who a playlist is shared with.
function requireOwner(req, res) {
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found) { res.status(404).json({ error: 'Not found' }); return false; }
  if (role !== 'owner') { res.status(403).json({ error: 'Only the owner can manage sharing' }); return false; }
  return true;
}

api.get('/playlists/:id/shares', (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json(db.prepare(`
    SELECT ps.user_id, u.username, ps.can_edit, ps.created_at FROM playlist_shares ps
    JOIN users u ON u.id = ps.user_id WHERE ps.playlist_id = ? ORDER BY u.username COLLATE NOCASE
  `).all(req.params.id));
});

// Share with a user (or update their permission). Body: { user_id, can_edit }.
api.post('/playlists/:id/shares', (req, res) => {
  if (!requireOwner(req, res)) return;
  const userId = parseInt(req.body?.user_id, 10);
  const canEdit = req.body?.can_edit ? 1 : 0;
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'user_id required' });
  const owner = db.prepare('SELECT user_id FROM playlists WHERE id = ?').get(req.params.id)?.user_id;
  if (userId === owner) return res.status(400).json({ error: "You already own this playlist" });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  db.prepare(`
    INSERT INTO playlist_shares (playlist_id, user_id, can_edit) VALUES (?, ?, ?)
    ON CONFLICT(playlist_id, user_id) DO UPDATE SET can_edit = excluded.can_edit
  `).run(req.params.id, userId, canEdit);
  res.json({ ok: true, user_id: userId, can_edit: !!canEdit });
});

api.delete('/playlists/:id/shares/:userId', (req, res) => {
  if (!requireOwner(req, res)) return;
  db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ? AND user_id = ?')
    .run(req.params.id, parseInt(req.params.userId, 10));
  res.json({ ok: true });
});

}
