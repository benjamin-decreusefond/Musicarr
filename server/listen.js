import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';

// Listen Together: synchronized group playback. One user hosts a session and
// drives the current track / position / play-state; guests poll the session and
// follow along. No realtime transport needed — clients poll every couple of
// seconds, which is plenty for keeping playback loosely in sync.
export const listenRouter = Router();

// Sessions with no host update for 2h are considered abandoned and get reaped;
// guests not seen for 1m drop out of the member list (see pruneStale below).
const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
// Unambiguous human-typable code (no 0/O/1/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(len = 6) {
  let s = '';
  for (const b of crypto.randomBytes(len)) s += ALPHABET[b % ALPHABET.length];
  return s;
}

function pruneStale() {
  try {
    db.prepare(`DELETE FROM listen_sessions WHERE updated_at < datetime('now', '-2 hours')`).run();
    db.prepare(`DELETE FROM listen_members WHERE last_seen < datetime('now', '-1 minutes')`).run();
    // A session with no remaining members is over.
    db.prepare(`DELETE FROM listen_sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM listen_members)`).run();
  } catch { /* best-effort */ }
}
setInterval(pruneStale, 60 * 1000).unref?.();

// Full session state for the client: current track metadata + members.
function sessionState(session, viewerId) {
  const members = db.prepare(`
    SELECT u.id, u.username, (lm.user_id = ls.host_id) AS is_host
    FROM listen_members lm
    JOIN users u ON u.id = lm.user_id
    JOIN listen_sessions ls ON ls.id = lm.session_id
    WHERE lm.session_id = ? AND lm.last_seen > datetime('now','-1 minutes')
    ORDER BY is_host DESC, u.username COLLATE NOCASE
  `).all(session.id);

  let track = null;
  if (session.track_id) {
    track = db.prepare(`
      SELECT deezer_id, title, artist, artist_id, album, album_id, cover, duration,
             (file_path IS NOT NULL) AS available
      FROM tracks WHERE deezer_id = ?
    `).get(session.track_id) || null;
  }
  const host = db.prepare('SELECT username FROM users WHERE id = ?').get(session.host_id);
  return {
    id: session.id,
    code: session.code,
    host_id: session.host_id,
    host_name: host?.username || null,
    is_host: session.host_id === viewerId,
    track_id: session.track_id,
    position: session.position,
    is_playing: !!session.is_playing,
    updated_at: session.updated_at,
    server_time: nowIso(),
    track,
    members,
  };
}

const getSessionById = (id) => db.prepare('SELECT * FROM listen_sessions WHERE id = ?').get(id);
const touchMember = (sessionId, userId) =>
  db.prepare(`UPDATE listen_members SET last_seen = datetime('now') WHERE session_id = ? AND user_id = ?`)
    .run(sessionId, userId);

// The session (if any) the user is currently part of — lets the client resume
// after a reload.
listenRouter.get('/active', (req, res) => {
  pruneStale();
  const row = db.prepare(`
    SELECT ls.* FROM listen_sessions ls
    JOIN listen_members lm ON lm.session_id = ls.id
    WHERE lm.user_id = ? ORDER BY ls.updated_at DESC LIMIT 1
  `).get(req.user.id);
  if (!row) return res.json({ active: false });
  touchMember(row.id, req.user.id);
  res.json({ active: true, session: sessionState(row, req.user.id) });
});

// Start hosting (or return the session the user already hosts).
listenRouter.post('/start', (req, res) => {
  let existing = db.prepare('SELECT * FROM listen_sessions WHERE host_id = ?').get(req.user.id);
  if (existing) {
    touchMember(existing.id, req.user.id);
    return res.json(sessionState(existing, req.user.id));
  }
  // A user can only be in one session at a time.
  db.prepare('DELETE FROM listen_members WHERE user_id = ?').run(req.user.id);
  let code;
  for (let i = 0; i < 5; i++) { code = makeCode(); if (!db.prepare('SELECT 1 FROM listen_sessions WHERE code = ?').get(code)) break; }
  const info = db.prepare('INSERT INTO listen_sessions (host_id, code) VALUES (?, ?)').run(req.user.id, code);
  db.prepare('INSERT INTO listen_members (session_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.user.id);
  res.json(sessionState(getSessionById(info.lastInsertRowid), req.user.id));
});

// Join a session by its share code.
listenRouter.post('/join', (req, res) => {
  const code = (req.body?.code || '').toString().trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'A session code is required' });
  const session = db.prepare('SELECT * FROM listen_sessions WHERE code = ?').get(code);
  if (!session) return res.status(404).json({ error: 'No session with that code' });
  // Leave any other session first (one at a time), unless re-joining the same.
  db.prepare('DELETE FROM listen_members WHERE user_id = ? AND session_id != ?').run(req.user.id, session.id);
  db.prepare(`
    INSERT INTO listen_members (session_id, user_id) VALUES (?, ?)
    ON CONFLICT(session_id, user_id) DO UPDATE SET last_seen = datetime('now')
  `).run(session.id, req.user.id);
  res.json(sessionState(session, req.user.id));
});

// Poll current state (also refreshes this member's presence).
listenRouter.get('/:id', (req, res) => {
  const session = getSessionById(parseInt(req.params.id, 10));
  if (!session) return res.status(404).json({ error: 'Session ended' });
  const isMember = db.prepare('SELECT 1 FROM listen_members WHERE session_id = ? AND user_id = ?').get(session.id, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'Not in this session' });
  touchMember(session.id, req.user.id);
  res.json(sessionState(session, req.user.id));
});

// Host pushes playback state. Guests calling this are ignored (403).
listenRouter.post('/:id/state', (req, res) => {
  const session = getSessionById(parseInt(req.params.id, 10));
  if (!session) return res.status(404).json({ error: 'Session ended' });
  if (session.host_id !== req.user.id) return res.status(403).json({ error: 'Only the host controls playback' });
  const b = req.body || {};
  const trackId = b.track_id == null ? null : parseInt(b.track_id, 10);
  const position = Math.max(0, Number(b.position) || 0);
  const isPlaying = b.is_playing ? 1 : 0;
  db.prepare(`
    UPDATE listen_sessions SET track_id = ?, position = ?, is_playing = ?, updated_at = datetime('now') WHERE id = ?
  `).run(Number.isFinite(trackId) ? trackId : null, position, isPlaying, session.id);
  touchMember(session.id, req.user.id);
  res.json({ ok: true });
});

// Leave the session. If the host leaves, the whole session ends.
listenRouter.post('/:id/leave', (req, res) => {
  const session = getSessionById(parseInt(req.params.id, 10));
  if (!session) return res.json({ ok: true });
  if (session.host_id === req.user.id) db.prepare('DELETE FROM listen_sessions WHERE id = ?').run(session.id);
  else db.prepare('DELETE FROM listen_members WHERE session_id = ? AND user_id = ?').run(session.id, req.user.id);
  res.json({ ok: true });
});
