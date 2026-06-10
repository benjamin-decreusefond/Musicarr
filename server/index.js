import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './db.js';
import { authMiddleware, authRouter, usersRouter, bootstrapAdmin } from './auth.js';
import { deezerRouter } from './sources.js';
import { api } from './api.js';
import { startPoller, resumeOnBoot } from './downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/deezer', deezerRouter);
app.use('/api', api);

// Serve the built SPA.
const webDir = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(webDir));
app.get(/^\/(?!api|healthz).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));

bootstrapAdmin();
resumeOnBoot();
startPoller();

app.listen(config.port, () => {
  console.log(`[musicarr] listening on :${config.port}`);
  console.log(`[musicarr] jackett=${config.jackettUrl || 'NOT SET'} transmission=${config.transmissionUrl}`);
});
