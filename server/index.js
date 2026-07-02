import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, pingDb } from './db.js';
import { authMiddleware, authRouter, usersRouter, bootstrapAdmin, requireAuth } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { deezerRouter } from './sources.js';
import { socialRouter } from './social.js';
import { listenRouter } from './listen.js';
import { api } from './api.js';
import { startPoller, resumeOnBoot, scanLibrary } from './downloader.js';
import { startReleaseWatcher } from './releases.js';
import { startBackups } from './backup.js';
import { logger } from './log.js';

const log = logger('http');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind nginx/ingress: trust a *bounded* number of proxy hops so req.ip is the
// real client. Trusting every hop (true) lets a client spoof X-Forwarded-For and
// bypass per-IP login rate limiting, so default to 1 and let deployments with a
// deeper proxy chain override via TRUST_PROXY (a hop count, or true/false).
const tp = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : (Number.isNaN(Number(tp)) ? tp : Number(tp)));
app.disable('x-powered-by');

// Baseline security headers for an internet-exposed app (no extra deps).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https: data:",            // Deezer cover art is served over https
  "media-src 'self'",                        // audio is streamed from our own origin
  "connect-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', CSP);
  // Only advertise HSTS when we're actually behind TLS (the same signal that
  // marks the session cookie Secure); never on a plain-HTTP/LAN deployment.
  if (config.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Health/probe endpoints — registered before auth and the SPA fallback so they
// are cheap, dependency-light, and return a *real* status instead of being
// swallowed by the catch-all that serves index.html (which would always be 200).
//
// Liveness: the process is up and the event loop responds. Deliberately does NOT
// touch the DB or slskd, so a slow dependency can never trigger a restart loop.
const liveness = (_req, res) => res.json({ ok: true });
app.get('/healthz', liveness);
app.get('/health', liveness);
app.get('/health/live', liveness);
// Readiness: only take traffic when SQLite is reachable. slskd status is reported
// for visibility but does not gate readiness — it being down shouldn't pull the
// pod out of rotation when browsing/streaming still works.
app.get('/health/ready', (_req, res) => {
  try {
    pingDb();
    res.json({ ok: true, db: 'ok', slskd: config.slskdEnabled ? 'configured' : 'not_configured' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'error', error: String(e.message || e) });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
// The Deezer proxy is metadata-only but must still require a signed-in user
// (it was previously reachable unauthenticated) and, like /search, be rate
// limited so one runaway client can't get the server blocked by Deezer.
app.use('/api/deezer', requireAuth, rateLimit({ windowMs: 60_000, max: 120 }), deezerRouter);
app.use('/api/social', requireAuth, socialRouter);
app.use('/api/listen', requireAuth, listenRouter);
app.use('/api', api);

// Surface server-side API errors in the logs instead of swallowing them.
app.use('/api', (err, req, res, next) => {
  log.error(`${req.method} ${req.originalUrl} failed`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: String(err.message || err) });
});

// Serve the built SPA.
const webDir = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(webDir));
app.get(/^\/(?!api|healthz).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));

bootstrapAdmin();
scanLibrary();
resumeOnBoot();
startPoller();
startReleaseWatcher();
startBackups();

app.listen(config.port, () => {
  log.info(`listening on :${config.port}`);
  log.info(`root folder: ${config.musicDir}`);
  log.info(`slskd: ${config.slskdUrl || 'NOT SET'} (downloads dir ${config.slskdDownloadDir})`);
  if (!config.slskdEnabled) log.warn('Soulseek (slskd) not configured — downloads will fail until set under Settings');
});
