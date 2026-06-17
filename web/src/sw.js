/* Musicarr service worker — offline app shell + on-demand offline tracks.
 *
 * Caches:
 *  - SHELL: the static app bundle (HTML/JS/CSS/icon) so the UI loads offline.
 *  - DATA:  network-first cache of a few key GET APIs (me/library/playlists/
 *           mixes) so the app can boot and browse while offline.
 *  - IMG:   cover art (cross-origin, opaque) so the UI isn't blank offline.
 *  - AUDIO: tracks the user explicitly saved for offline; served back with
 *           HTTP range support so seeking works without a network.
 */
const VERSION = 'v1';
const SHELL = `musicarr-shell-${VERSION}`;
const DATA = `musicarr-data-${VERSION}`;
const IMG = `musicarr-img-${VERSION}`;
const AUDIO = 'musicarr-audio-v1'; // kept stable across versions: holds user downloads

const SHELL_ASSETS = ['/', '/index.html', '/app.js', '/app.css', '/favicon.svg', '/manifest.webmanifest'];
// GET APIs worth keeping a fallback copy of, so the shell can render offline.
const DATA_APIS = ['/api/auth/me', '/api/library', '/api/playlists', '/api/mixes'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, IMG, AUDIO]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isAudio = (url) => url.pathname.startsWith('/api/stream/');
const isData = (url) => DATA_APIS.some(p => url.pathname === p);
const isShellAsset = (url) => url.origin === self.location.origin &&
  (SHELL_ASSETS.includes(url.pathname) || url.pathname === '/app.js' || url.pathname === '/app.css');
const isCoverImg = (url) => /\.(jpg|jpeg|png|webp|gif)$/i.test(url.pathname) ||
  url.hostname.endsWith('dzcdn.net') || url.hostname.endsWith('deezer.com');

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return; // never cache writes
  const url = new URL(request.url);

  if (isAudio(url)) return e.respondWith(serveAudio(request));
  if (request.mode === 'navigate') return e.respondWith(navFallback(request));
  if (isData(url)) return e.respondWith(networkFirst(request, DATA));
  if (isShellAsset(url)) return e.respondWith(cacheFirst(request, SHELL));
  if (isCoverImg(url)) return e.respondWith(cacheFirst(request, IMG));
  // Everything else: try network, fall back to any cached copy.
  e.respondWith(fetch(request).catch(() => caches.match(request)));
});

async function navFallback(request) {
  try { return await fetch(request); }
  catch { return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error(); }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) (await caches.open(cacheName)).put(request, res.clone());
    return res;
  } catch { return cached || Response.error(); }
}

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res && res.ok) (await caches.open(cacheName)).put(request, res.clone());
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || Response.error();
  }
}

// Serve a saved track from the AUDIO cache, honouring the Range header so the
// <audio> element can seek. Falls through to the network when not saved.
async function serveAudio(request) {
  const cache = await caches.open(AUDIO);
  const cached = await cache.match(request.url, { ignoreVary: true });
  if (!cached) { try { return await fetch(request); } catch { return new Response('', { status: 504 }); } }

  const type = cached.headers.get('Content-Type') || 'audio/mpeg';
  const buf = await cached.arrayBuffer();
  const range = request.headers.get('range');
  if (!range) {
    return new Response(buf, { status: 200, headers: {
      'Content-Type': type, 'Content-Length': String(buf.byteLength), 'Accept-Ranges': 'bytes' } });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0;
  let end = m && m[2] !== '' ? parseInt(m[2], 10) : buf.byteLength - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= buf.byteLength) end = buf.byteLength - 1;
  if (start > end) start = 0;
  const slice = buf.slice(start, end + 1);
  return new Response(slice, { status: 206, headers: {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(slice.byteLength),
  } });
}
