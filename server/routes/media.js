import fs from 'node:fs';
import { db, avatarPath } from '../db.js';
import { deezerGet } from '../sources.js';
import { createCache } from '../cache.js';
export function registerMedia(api) {
/* ------------------------------------------------------- Profile avatars */
// Avatars are small JPEGs the user uploads from their Profile. Stored on disk
// (DATA_DIR/avatars/<id>.jpg) and served same-origin so the CSP covers them.
const MAX_AVATAR_BYTES = 600 * 1024; // generous for a client-downscaled JPEG

api.get('/avatar/:id', (req, res) => {
  const p = avatarPath(req.params.id);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No avatar' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(p).on('error', () => { if (!res.headersSent) res.sendStatus(500); }).pipe(res);
});

// Upload/replace your own avatar. Body: { image: "data:image/jpeg;base64,..." }.
// The client downscales to a small square JPEG before sending.
api.post('/avatar', (req, res) => {
  const data = (req.body?.image || '').toString();
  const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return res.status(400).json({ error: 'Expected a JPEG data URL' });
  let buf;
  try { buf = Buffer.from(m[1], 'base64'); } catch { return res.status(400).json({ error: 'Invalid image data' }); }
  if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return res.status(400).json({ error: 'Image too large' });
  // Sanity-check the JPEG magic bytes (FF D8 FF) so we only store real images.
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return res.status(400).json({ error: 'Not a JPEG image' });
  try { fs.writeFileSync(avatarPath(req.user.id), buf); }
  catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  res.json({ ok: true });
});

api.delete('/avatar', (req, res) => {
  try { fs.unlinkSync(avatarPath(req.user.id)); } catch { /* already gone */ }
  res.json({ ok: true });
});

/* ------------------------------------------------------- Track previews */
// Stream Deezer's free ~30s preview for a track through our own origin. This
// keeps playback under media-src 'self' (a cross-origin dzcdn URL would be
// blocked by the CSP) and hides Deezer's signed, short-lived preview URLs from
// the client. Used to audition songs that aren't downloaded yet.
api.get('/preview/:trackId', async (req, res) => {
  const id = parseInt(req.params.trackId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid track id' });
  try {
    const t = await deezerGet(`track/${id}`);
    const url = t?.preview;
    if (!url) return res.status(404).json({ error: 'No preview available for this track' });
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).json({ error: `Preview source ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.end(buf);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* -------------------------------------------------------------- Lyrics */
// Lyrics come from LRCLIB (https://lrclib.net) — a free, key-less database with
// both plain and time-synced lyrics. Results are cached for a day.
const lyricsCache = createCache({ ttlMs: 24 * 60 * 60 * 1000, max: 2000 });
const LRCLIB = (process.env.LRCLIB_URL || 'https://lrclib.net').replace(/\/$/, '');
const LRC_UA = 'Musicarr (https://github.com/benjamin-decreusefond/musicarr)';

// Parse an LRC string into ordered { time, text } lines for synced display.
function parseLrc(s) {
  if (!s) return [];
  const out = [];
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    for (const st of m[1].matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
      const frac = st[3] ? Number(st[3]) / (st[3].length === 2 ? 100 : 1000) : 0;
      out.push({ time: (+st[1]) * 60 + (+st[2]) + frac, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

async function lrclibFetch(pathAndQuery) {
  const r = await fetch(`${LRCLIB}${pathAndQuery}`, {
    headers: { 'User-Agent': LRC_UA }, signal: AbortSignal.timeout(10000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`LRCLIB ${r.status}`);
  return r.json();
}

api.get('/lyrics/:trackId', async (req, res) => {
  const id = parseInt(req.params.trackId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid track id' });
  try {
    // Prefer our catalog; fall back to Deezer for not-yet-imported tracks.
    let t = db.prepare('SELECT title, artist, album, duration FROM tracks WHERE deezer_id = ?').get(id);
    if (!t?.title) {
      const d = await deezerGet(`track/${id}`);
      t = { title: d.title, artist: d.artist?.name, album: d.album?.title, duration: d.duration };
    }
    if (!t?.title || !t?.artist) return res.status(404).json({ error: 'Unknown track' });

    const key = `${t.artist}|${t.title}|${t.album || ''}|${t.duration || ''}`;
    const data = await lyricsCache.wrap(key, async () => {
      // Exact signature match first (artist+title+album+duration), then a fuzzy search.
      const qs = new URLSearchParams({ artist_name: t.artist, track_name: t.title });
      if (t.album) qs.set('album_name', t.album);
      if (t.duration) qs.set('duration', String(t.duration));
      let body = await lrclibFetch(`/api/get?${qs}`);
      if (!body || (!body.syncedLyrics && !body.plainLyrics)) {
        const arr = await lrclibFetch(`/api/search?${new URLSearchParams({ track_name: t.title, artist_name: t.artist })}`);
        body = Array.isArray(arr) ? arr.find(x => x.syncedLyrics || x.plainLyrics) : null;
      }
      if (!body) return { found: false };
      return {
        found: !!(body.syncedLyrics || body.plainLyrics),
        synced: parseLrc(body.syncedLyrics),
        plain: body.plainLyrics || '',
      };
    });
    if (!data.found) return res.status(404).json({ error: 'No lyrics found for this track' });
    res.json({ synced: data.synced, plain: data.plain });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ------------------------------------------------------------- Streaming */
api.get('/stream/:trackId', (req, res) => {
  const row = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(req.params.trackId);
  if (!row?.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Not in library' });

  const stat = fs.statSync(row.file_path);
  const size = stat.size;
  const range = req.headers.range;
  const types = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac' };
  const ext = row.file_path.slice(row.file_path.lastIndexOf('.')).toLowerCase();
  const contentType = types[ext] || 'application/octet-stream';

  const send = (status, headers, start, end) => {
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || start > end) return res.end();
    const stream = fs.createReadStream(row.file_path, { start, end });
    stream.on('error', (e) => { if (!res.headersSent) res.sendStatus(500); res.destroy(e); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0;
    let end = m && m[2] !== '' ? parseInt(m[2], 10) : size - 1;
    // Unsatisfiable range (e.g. browser probing past EOF) -> 416, not a
    // malformed 206 that stalls the element right at the end of the track.
    if (!m || Number.isNaN(start) || start >= size || start < 0) {
      return res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }).end();
    }
    if (Number.isNaN(end) || end >= size) end = size - 1; // clamp to EOF
    if (end < start) end = start;
    send(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    }, start, end);
  } else {
    send(200, { 'Content-Length': size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }, 0, size - 1);
  }
});
}
