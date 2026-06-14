import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './db.js';
import { authMiddleware, authRouter, usersRouter, bootstrapAdmin, requireAuth } from './auth.js';
import { deezerRouter } from './sources.js';
import { socialRouter } from './social.js';
import { api } from './api.js';
import { startPoller, resumeOnBoot, scanLibrary } from './downloader.js';
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
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
// The Deezer proxy is metadata-only but must still require a signed-in user
// (it was previously reachable unauthenticated).
app.use('/api/deezer', requireAuth, deezerRouter);
app.use('/api/social', requireAuth, socialRouter);
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

app.listen(config.port, () => {
  log.info(`listening on :${config.port}`);
  log.info(`root folder: ${config.musicDir}`);
  log.info(`slskd: ${config.slskdUrl || 'NOT SET'} (downloads dir ${config.slskdDownloadDir})`);
  if (!config.slskdEnabled) log.warn('Soulseek (slskd) not configured — downloads will fail until set under Settings');
});
