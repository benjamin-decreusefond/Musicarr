import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db, config } from './db.js';

const COOKIE = 'musicarr_session';
// A fixed bcrypt hash compared against on unknown usernames so a failed login
// takes the same time whether or not the user exists (no enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('musicarr-timing-equalizer', 10);

// Personal access tokens are high-entropy random strings, so a plain SHA-256
// (fast, but with nothing to brute-force) is the right hash to store — unlike
// passwords, which need bcrypt's deliberate slowness.
const TOKEN_PREFIX = 'mcr_';
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const MAX_TOKENS_PER_USER = 50;

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
  // Fall back to a personal access token for programmatic clients. Accept it
  // either as `Authorization: Bearer <token>` or `X-Api-Key: <token>`.
  if (!req.user) authWithToken(req);
  next();
}

function authWithToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const presented = (m ? m[1] : req.headers['x-api-key'] || '').trim();
  if (!presented) return;
  const row = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.must_change_password, t.id AS token_id, t.last_used_at
    FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?
  `).get(hashToken(presented));
  if (!row) return;
  req.user = { id: row.id, username: row.username, is_admin: row.is_admin, must_change_password: row.must_change_password };
  req.apiToken = true;
  // Record usage, but throttle the write to at most once a minute per token so
  // a busy client doesn't generate a DB write on every single request.
  const minuteAgo = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
  if (!row.last_used_at || row.last_used_at < minuteAgo) {
    try { db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.token_id); }
    catch { /* best-effort */ }
  }
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

// --- Personal access tokens (programmatic API access) ---
// Token creation/revocation requires an interactive session, not a token, so a
// leaked token can't mint more tokens for itself.
function requireSession(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.apiToken) return res.status(403).json({ error: 'API tokens cannot manage other tokens — sign in to do that' });
  next();
}

authRouter.get('/tokens', requireSession, (req, res) => {
  res.json(db.prepare(
    'SELECT id, name, token_prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC'
  ).all(req.user.id));
});

authRouter.post('/tokens', requireSession, (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'A name is required' });
  if (name.length > 80) return res.status(400).json({ error: 'Name must be 80 characters or fewer' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get(req.user.id).n;
  if (count >= MAX_TOKENS_PER_USER) {
    return res.status(400).json({ error: `Token limit reached (${MAX_TOKENS_PER_USER}). Revoke one first.` });
  }
  // 32 random bytes → 256 bits of entropy. The plaintext is returned exactly
  // once here; only its hash is stored.
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const prefix = raw.slice(0, TOKEN_PREFIX.length + 6);
  const info = db.prepare(
    'INSERT INTO api_tokens (user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, name, hashToken(raw), prefix);
  const row = db.prepare('SELECT id, name, token_prefix, created_at, last_used_at FROM api_tokens WHERE id = ?')
    .get(info.lastInsertRowid);
  res.json({ ...row, token: raw });
});

authRouter.delete('/tokens/:id', requireSession, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, req.user.id);
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
