import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db, config } from './db.js';

const COOKIE = 'musicarr_session';
// A fixed bcrypt hash compared against on unknown usernames so a failed login
// takes the same time whether or not the user exists (no enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('musicarr-timing-equalizer', 10);

/** Shared password policy for new/changed passwords. Returns an error string or null. */
export function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters';
  return null;
}

export function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const isDefault = config.adminPassword === 'admin';
    const hash = bcrypt.hashSync(config.adminPassword, 10);
    db.prepare('INSERT INTO users (username, password_hash, is_admin, must_change_password) VALUES (?, ?, 1, ?)')
      .run(config.adminUsername, hash, isDefault ? 1 : 0);
    console.log(`[auth] Created admin user "${config.adminUsername}"${isDefault ? ' with DEFAULT password "admin" — you will be required to change it on first sign-in.' : ''}`);
  }
  // Drop expired sessions on boot, then hourly.
  cleanupSessions();
  setInterval(cleanupSessions, 60 * 60 * 1000).unref?.();
}

function cleanupSessions() {
  try { db.prepare(`DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run(); }
  catch { /* ignore */ }
}

/* ------------------------------------------------------------ Rate limiting */
// In-memory sliding window per client IP, to blunt password brute-forcing.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> number[] (timestamps)
function loginRateLimited(ip) {
  const now = Date.now();
  const hits = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  hits.push(now);
  loginAttempts.set(ip, hits);
  if (loginAttempts.size > 5000) { // bound memory
    for (const [k, v] of loginAttempts) if (!v.some(t => now - t < LOGIN_WINDOW_MS)) loginAttempts.delete(k);
  }
  return hits.length > LOGIN_MAX_ATTEMPTS;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function authMiddleware(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.must_change_password, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?
    `).get(token);
    if (row && row.expires_at && row.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      // Expired: drop it and treat as signed-out.
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    } else if (row) {
      req.user = { id: row.id, username: row.username, is_admin: row.is_admin, must_change_password: row.must_change_password };
      req.sessionToken = token;
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

export const authRouter = Router();

const sessionCookie = (token, maxAgeSec) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}` +
  (maxAgeSec != null ? `; Max-Age=${maxAgeSec}` : '');

authRouter.post('/login', (req, res) => {
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  }
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  // Always run a bcrypt compare (against a dummy hash for unknown users) so the
  // response time doesn't reveal whether the username exists.
  const ok = bcrypt.compareSync(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const ttlSec = config.sessionTtlDays * 24 * 60 * 60;
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(token, user.id, `+${config.sessionTtlDays} days`);
  res.setHeader('Set-Cookie', sessionCookie(token, ttlSec));
  res.json({ id: user.id, username: user.username, is_admin: !!user.is_admin, must_change_password: !!user.must_change_password });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ ...req.user, is_admin: !!req.user.is_admin, must_change_password: !!req.user.must_change_password });
});

authRouter.post('/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current || '', user.password_hash)) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  const bad = validatePassword(next);
  if (bad) return res.status(400).json({ error: bad });
  if (next === (current || '')) return res.status(400).json({ error: 'New password must differ from the current one' });
  // Changing the password also clears the forced-rotation flag and signs out
  // every other session for this user.
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(next, 10), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  res.json({ ok: true });
});

// --- Admin: user management ---
export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);

usersRouter.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all());
});

usersRouter.post('/', (req, res) => {
  const { username, password, is_admin } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const bad = validatePassword(password);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 10), is_admin ? 1 : 0);
    res.json({ id: info.lastInsertRowid, username, is_admin: !!is_admin });
  } catch {
    res.status(409).json({ error: 'Username already taken' });
  }
});

usersRouter.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});
