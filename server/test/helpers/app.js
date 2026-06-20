// Builds Express apps for tests and a small HTTP client (using the real fetch
// captured before the stub) that talks to a started server.

import http from 'node:http';
import express from 'express';
import { realFetch } from './env.js';
import { api } from '../../api.js';
import { deezerRouter } from '../../sources.js';
import { socialRouter } from '../../social.js';
import { listenRouter } from '../../listen.js';
import { requireAuth, authMiddleware, authRouter, usersRouter } from '../../auth.js';

// The user injected into requests by the authenticated app. Set via setUser().
let currentUser = null;
export function setUser(u) { currentUser = u; }

// App mirroring index.js wiring for the signed-in API surface, but with auth
// faked by injecting `currentUser` so route logic can be tested directly.
export function makeAuthedApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { if (currentUser) req.user = currentUser; next(); });
  app.use('/api/deezer', requireAuth, deezerRouter);
  app.use('/api/social', requireAuth, socialRouter);
  app.use('/api/listen', requireAuth, listenRouter);
  app.use('/api', api);
  app.use('/api', (err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return next(err);
    res.status(500).json({ error: String(err.message || err) });
  });
  return app;
}

// App exercising the REAL auth stack (cookies + tokens), as index.js mounts it.
export function makeRealAuthApp() {
  const app = express();
  // Mirror index.js: trust the proxy so X-Forwarded-For sets req.ip (lets tests
  // isolate the per-IP login rate limiter by varying the forwarded address).
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  return app;
}

// Start an app on an ephemeral port; returns { url, close }.
export function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// JSON request helper over the real fetch. Returns { status, body, headers }.
export async function req(base, method, pathAndQuery, { body, headers } = {}) {
  const res = await realFetch(base + pathAndQuery, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers, raw: text };
}
