import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db, config, avatarUrl } from './db.js';

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

// Session cookies carry a high-entropy random token; we store only its SHA-256
// hash so a leaked database (or a nightly backup) can't be used to resume live
// sessions. Same reasoning as API tokens above.
const hashSession = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/** Shared password policy for new/changed passwords. Returns an error string or null. */
export function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters';
  return null;
}

export function bootstrapAdmin() {
  const method = config.authMethod;
  if (method === 'none') {
    // No login: make sure the single shared user the middleware injects exists.
    noAuthUser();
    console.log('[auth] AUTH_METHOD=none — authentication is disabled; every request acts as a single admin user. Only run this on a trusted/isolated network.');
  } else {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count === 0 && method === 'proxy' && !process.env.ADMIN_PASSWORD) {
      // In proxy mode users are provisioned from the identity header on first
      // request, so there's no need to seed (and log) a random native admin.
      console.log(`[auth] AUTH_METHOD=proxy — users are provisioned from the "${config.authProxyHeader}" header on first request. ` +
        'The first user seen becomes an admin (or list admins in AUTH_PROXY_ADMIN_USERS). Set ADMIN_PASSWORD to also seed a break-glass native admin.');
    } else if (count === 0) {
      // If no ADMIN_PASSWORD was provided, don't fall back to the well-known
      // "admin" default (a real window where anyone can log in). Generate a strong
      // random one, print it once to the logs, and force a change on first sign-in.
      const envHadPassword = !!process.env.ADMIN_PASSWORD;
      let password = config.adminPassword;
      let generated = null;
      if (!envHadPassword) {
        generated = crypto.randomBytes(12).toString('base64url'); // ~16 chars, 96 bits
        password = generated;
      }
      const mustChange = generated != null || password === 'admin';
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO users (username, password_hash, is_admin, must_change_password) VALUES (?, ?, 1, ?)')
        .run(config.adminUsername, hash, mustChange ? 1 : 0);
      if (generated) {
        console.log(`[auth] Created admin user "${config.adminUsername}" with a generated password:\n\n    ${generated}\n\n` +
          `[auth] Sign in with it now — you'll be required to set your own password. (Set ADMIN_PASSWORD to choose your own seed.)`);
      } else {
        console.log(`[auth] Created admin user "${config.adminUsername}"${mustChange ? ' with DEFAULT password "admin" — you will be required to change it on first sign-in.' : ''}`);
      }
      if (method === 'proxy') {
        console.log('[auth] AUTH_METHOD=proxy — the seed admin above is a break-glass native login; proxy users are still provisioned from the identity header.');
      }
    }
  }
  // Drop expired sessions on boot, then hourly.
  cleanupSessions();
  setInterval(cleanupSessions, 60 * 60 * 1000).unref?.();
}

// --- AUTH_METHOD=none ---------------------------------------------------------
/** The single implicit user injected for every request when auth is disabled.
 *  Reuses an existing admin when the database already has one (e.g. after
 *  switching over from login mode); otherwise creates a passwordless admin.
 *  The stored hash is random and unusable — there is no login in this mode. */
function noAuthUser() {
  let u = db.prepare('SELECT * FROM users WHERE username = ?').get(config.adminUsername)
    || db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  if (!u) {
    const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin, must_change_password) VALUES (?, ?, 1, 0)'
    ).run(config.adminUsername, hash);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  return u;
}

// --- AUTH_METHOD=proxy --------------------------------------------------------
// Strip an IPv4-mapped IPv6 prefix so a socket address compares cleanly against
// a configured plain-IPv4 allowlist entry.
const normalizeIp = (ip) => (ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip || '');

/** Whether the identity header may be trusted for this request: the raw TCP peer
 *  (the proxy, not the spoofable X-Forwarded-For) must be in AUTH_PROXY_TRUSTED_IPS.
 *  An empty allowlist trusts any source (the app must then be proxy-only). */
function proxyPeerTrusted(req) {
  const allow = config.authProxyTrustedIps;
  if (allow.length === 0) return true;
  return allow.includes(normalizeIp(req.socket?.remoteAddress || ''));
}

/** Resolve (and auto-provision) the user named by the trusted proxy header. */
function resolveProxyUser(req) {
  if (!proxyPeerTrusted(req)) return null;
  const raw = req.headers[config.authProxyHeader];
  const username = (Array.isArray(raw) ? raw[0] : raw || '').trim();
  if (!username) return null;
  const shouldBeAdmin = config.authProxyAdminUsers.includes(username.toLowerCase());
  let u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) {
    // Auto-provision. The very first user provisioned becomes an admin so the
    // instance is manageable; after that, admin is granted only to names listed
    // in AUTH_PROXY_ADMIN_USERS.
    const firstEver = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin, must_change_password) VALUES (?, ?, ?, 0)'
    ).run(username, hash, (shouldBeAdmin || firstEver) ? 1 : 0);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else if (shouldBeAdmin && !u.is_admin) {
    // Keep an existing user's admin flag in sync with the config list.
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
    u.is_admin = 1;
  }
  return u;
}

function cleanupSessions() {
  try { db.prepare(`DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run(); }
  catch { /* ignore */ }
}

/* ------------------------------------------------------------ Rate limiting */
// In-memory sliding window per client IP, to blunt password brute-forcing.
// Only FAILED attempts count: several people signing in from one household IP
// must never lock each other out, and success proves the caller knows a
// password (nothing left to brute-force).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> number[] (failure timestamps)
function loginRateLimited(ip) {
  const now = Date.now();
  const hits = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, hits);
  return hits.length >= LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const hits = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  hits.push(now);
  loginAttempts.set(ip, hits);
  if (loginAttempts.size > 5000) { // bound memory
    for (const [k, v] of loginAttempts) if (!v.some(t => now - t < LOGIN_WINDOW_MS)) loginAttempts.delete(k);
  }
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
  const method = config.authMethod;

  // AUTH_METHOD=none: no authentication — every request is the shared admin user.
  if (method === 'none') {
    const u = noAuthUser();
    req.user = { id: u.id, username: u.username, is_admin: u.is_admin, must_change_password: 0 };
    req.authVia = 'none';
    return next();
  }

  // Native session cookie. Works in every mode (incl. proxy), so a user who
  // signs in directly — e.g. a desktop client — is authenticated the same way.
  const token = parseCookies(req)[COOKIE];
  if (token) {
    const tokenHash = hashSession(token);
    const row = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.must_change_password, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?
    `).get(tokenHash);
    if (row && row.expires_at && row.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      // Expired: drop it and treat as signed-out.
      db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
    } else if (row) {
      req.user = { id: row.id, username: row.username, is_admin: row.is_admin, must_change_password: row.must_change_password };
      req.sessionToken = tokenHash;
      req.authVia = 'session';
    }
  }
  // Fall back to a personal access token for programmatic clients. Accept it
  // either as `Authorization: Bearer <token>` or `X-Api-Key: <token>`.
  if (!req.user) authWithToken(req);
  // Finally, trust the reverse proxy's identity header (proxy mode only). This
  // is last so a client's own credentials always take precedence.
  if (!req.user && method === 'proxy') {
    const u = resolveProxyUser(req);
    if (u) {
      req.user = { id: u.id, username: u.username, is_admin: u.is_admin, must_change_password: u.must_change_password };
      req.proxyAuth = true;
      req.authVia = 'proxy';
    }
  }
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
  req.authVia = 'token';
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
  if (config.authMethod === 'none') {
    return res.status(400).json({ error: 'Login is disabled (AUTH_METHOD=none)' });
  }
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  }
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  // Always run a bcrypt compare (against a dummy hash for unknown users) so the
  // response time doesn't reveal whether the username exists.
  const ok = bcrypt.compareSync(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const ttlSec = config.sessionTtlDays * 24 * 60 * 60;
  // Store only the hash; the raw token lives in the cookie and is never persisted.
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(hashSession(token), user.id, `+${config.sessionTtlDays} days`);
  res.setHeader('Set-Cookie', sessionCookie(token, ttlSec));
  res.json({ id: user.id, username: user.username, is_admin: !!user.is_admin, must_change_password: !!user.must_change_password });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(hashSession(token));
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const via = req.authVia || 'session';
  res.json({
    ...req.user,
    is_admin: !!req.user.is_admin,
    must_change_password: !!req.user.must_change_password,
    avatar: avatarUrl(req.user.id),
    // Tells the UI how the session is authenticated so it can hide controls that
    // don't apply (there's no password to change behind a proxy, no sign-out
    // when auth is disabled, and so on).
    auth_method: config.authMethod,
    auth_via: via,
    // A native session can change its password the usual way (prove the current
    // one). A proxy/SSO session has no current password but can *set* one for
    // direct client login (username + password from a desktop app), since the
    // identity provider already vouches for the request.
    can_change_password: via === 'session' && config.authMethod !== 'none',
    can_set_client_password: !!req.proxyAuth,
    logout_url: req.proxyAuth ? config.authProxyLogoutUrl : null,
  });
});

authRouter.post('/password', requireAuth, (req, res) => {
  // When auth is fully disabled there's no account to secure.
  if (config.authMethod === 'none') {
    return res.status(400).json({ error: 'Password is managed by your identity provider' });
  }
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // A proxy/SSO-authenticated request is already trusted by the identity
  // provider, and the account has no usable native password to prove — so it may
  // set (or replace) a client-login password without presenting the current one.
  // A native session must still prove its current password.
  if (!req.proxyAuth) {
    if (!bcrypt.compareSync(current || '', user.password_hash)) {
      return res.status(400).json({ error: 'Current password is wrong' });
    }
  }
  const bad = validatePassword(next);
  if (bad) return res.status(400).json({ error: bad });
  if (!req.proxyAuth && next === (current || '')) {
    return res.status(400).json({ error: 'New password must differ from the current one' });
  }
  // Setting/changing the password also clears the forced-rotation flag and signs
  // out every other native session for this user.
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(next, 10), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken || '');
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
