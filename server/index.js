import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './db.js';
import { authMiddleware, authRouter, usersRouter, bootstrapAdmin } from './auth.js';
import { deezerRouter } from './sources.js';
import { api } from './api.js';
import { startPoller, resumeOnBoot, scanLibrary } from './downloader.js';
import { logger } from './log.js';

const log = logger('http');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/deezer', deezerRouter);
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
