import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { db, config, avatarPath, isMbId } from '../db.js';
import { deezerGet } from '../sources.js';
import { createCache } from '../cache.js';
import { logger } from '../log.js';

const log = logger('stream');

// Optional on-the-fly transcode targets (?fmt=). Lower bitrate = less bandwidth
// for remote/mobile listening, at the cost of CPU. Requires ffmpeg on the server.
// `extra` pins each codec to constant bitrate. That costs a little quality
// versus VBR, and buys the thing VBR cannot give: a byte offset in the output
// corresponds to a known instant in the audio, which is what makes the stream
// seekable (see streamTranscoded). libopus defaults to VBR, so it has to be
// told; libmp3lame with -b:a is already CBR.
const TRANSCODE = {
  opus: { codec: 'libopus', container: 'ogg', type: 'audio/ogg', extra: ['-vbr', 'off'] },
  mp3: { codec: 'libmp3lame', container: 'mp3', type: 'audio/mpeg', extra: [] },
};

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
  // Previews are Deezer's 30s clips; MusicBrainz is a metadata database and has
  // no audio at all. The UI hides the button for these, so this is the answer
  // for an API client rather than something a user should ever see.
  if (isMbId(id)) return res.status(404).json({ error: 'No preview: this track comes from MusicBrainz, which has no audio' });
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
// Transcoding produces a stream whose length nobody knows in advance, and a
// media element that is given no Content-Length cannot seek: the scrubber only
// moves within what has already been buffered. On a phone on mobile data —
// exactly the case transcoding exists for — that made the feature half-useless.
//
// The fix is the one every streaming server uses: because the output is CBR, a
// byte offset maps to an instant (offset / bytesPerSecond), so we can *predict*
// the total size from the track's known duration, advertise it, and answer a
// Range request by starting ffmpeg at the matching timestamp. The element then
// treats the stream as an ordinary seekable file.
//
// The prediction is an estimate — container overhead and the encoder's final
// frame move it by a few kilobytes — so the response is truncated to exactly the
// length advertised. Being a few frames short at the very end of a track is
// invisible; sending more bytes than promised is a protocol violation.
// How much predicted-but-unproduced output is worth padding over. A CBR encoder
// lands within a few kilobytes; anything past this is a failed encode, not
// rounding, and is better surfaced than hidden behind half a megabyte of zeros.
const MAX_PAD_BYTES = 512 * 1024;

function streamTranscoded(req, res, row, fmt) {
  const t = TRANSCODE[fmt];
  const bitrate = Math.min(320, Math.max(32, parseInt(req.query.br, 10) || 128));
  const bytesPerSecond = (bitrate * 1000) / 8;
  const duration = Number(row.duration) > 0 ? Number(row.duration) : null;
  const total = duration ? Math.ceil(duration * bytesPerSecond) : null;

  // ?t= is the older, explicit seek (the client re-requests from a timestamp).
  // It makes the body shorter than the predicted total, so a request using it
  // falls back to the unsized, unseekable response rather than lying about its
  // length.
  const seekQuery = Math.max(0, Number(req.query.t) || 0);
  const rangeHeader = String(req.headers.range || '').trim();
  const sized = total !== null && !seekQuery;
  const m = sized && rangeHeader ? /^bytes=(\d+)-/.exec(rangeHeader) : null;
  const start = m ? parseInt(m[1], 10) : 0;

  // Past the end of a track the element is probing, not playing.
  if (sized && m && start >= total) {
    return res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' }).end();
  }

  const seek = m ? start / bytesPerSecond : seekQuery;
  const limit = sized ? total - start : null;
  const args = [
    ...(seek ? ['-ss', String(seek)] : []),
    '-i', row.file_path, '-vn',
    '-c:a', t.codec, '-b:a', `${bitrate}k`, ...t.extra,
    '-f', t.container, 'pipe:1',
  ];
  const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let started = false;
  ff.on('spawn', () => {
    started = true;
    const headers = sized
      ? (m
        ? { 'Content-Type': t.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${total - 1}/${total}`, 'Content-Length': limit }
        : { 'Content-Type': t.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': total })
      : { 'Content-Type': t.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' };
    res.writeHead(sized && m ? 206 : 200, headers);
    if (req.method === 'HEAD') { ff.kill('SIGKILL'); return res.end(); }

    // A manual pipe rather than stdout.pipe(res): the output has to be cut at
    // exactly `limit` bytes, and backpressure still has to be honoured or a slow
    // client makes the encoder buffer the whole track in memory.
    let sent = 0;
    ff.stdout.on('data', (chunk) => {
      if (limit !== null) {
        if (sent >= limit) return;
        if (sent + chunk.length > limit) chunk = chunk.subarray(0, limit - sent);
      }
      sent += chunk.length;
      if (!res.write(chunk)) ff.stdout.pause();
      if (limit !== null && sent >= limit) { ff.kill('SIGKILL'); res.end(); }
    });
    res.on('drain', () => ff.stdout.resume());
    ff.stdout.on('end', () => {
      // The mirror image of truncating: when the encoder stops a few kilobytes
      // short of the prediction, close the gap with zero bytes. Trailing zeros
      // are not decodable frames, so every player ignores them — whereas a body
      // shorter than its Content-Length is a truncated response, which browsers
      // surface as a network error mid-track. Padding beyond a few seconds'
      // worth would be papering over a real encode failure, so it is capped.
      const missing = limit === null ? 0 : limit - sent;
      if (missing > 0 && missing <= MAX_PAD_BYTES) res.write(Buffer.alloc(missing));
      res.end();
    });
  });
  ff.on('error', (e) => {
    log.warn(`transcode failed to start (is ffmpeg installed?): ${e.message}`);
    if (!started && !res.headersSent) res.status(500).json({ error: 'Transcoding is unavailable on this server' });
  });
  res.on('close', () => ff.kill('SIGKILL'));
}

api.get('/stream/:trackId', (req, res) => {
  const trackId = parseInt(req.params.trackId, 10);
  if (!Number.isFinite(trackId)) return res.status(400).json({ error: 'Invalid track id' });
  const row = db.prepare('SELECT file_path, duration FROM tracks WHERE deezer_id = ?').get(trackId);
  if (!row?.file_path || !fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Not in library' });

  // Opt-in transcoding for low-bandwidth clients (admin-enabled, needs ffmpeg).
  const fmt = String(req.query.fmt || '').toLowerCase();
  if (config.transcodeEnabled && TRANSCODE[fmt]) return streamTranscoded(req, res, row, fmt);

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
