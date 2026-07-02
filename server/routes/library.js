import fs from 'node:fs';
import { db, upsertArtist } from '../db.js';
import { requireAdmin } from '../auth.js';
import { deezerGet } from '../sources.js';
import { deleteTrackFile, scanLibrary, blockedPeers, clearPeerStrikes } from '../downloader.js';
import { startImportScan, scanState } from '../scanner.js';

// Escape LIKE wildcards in user input so "%"/"_" match literally.
const likeEscape = (s) => s.replace(/[\\%_]/g, '\\$&');

export function registerLibrary(api) {
  // Run async `fn` over `items` with at most `limit` calls in flight at once.
  async function mapLimit(items, limit, fn) {
    const queue = [...items];
    const worker = async () => { while (queue.length) await fn(queue.shift()); };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  }
/* ----------------------------------------------------------- Library view */
// A track is "available" to a user if its file exists on disk. Ownership is
// implicit: any signed-in user can play any imported file (shared library),
// but favorites/playlists are per-user.

// The library shows every track on disk, plus tracks currently being fetched
// so a download shows up the moment it's clicked. Each row carries `available`
// (file on disk) and the latest `download_status`.
// Optional query params (all off by default so existing clients see the full
// list unchanged): `q` filters title/artist/album server-side, and
// `limit`/`offset` paginate — big libraries shouldn't ship every row to search.
api.get('/library', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.min(1000, Math.max(0, parseInt(req.query.limit, 10) || 0));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const filter = q ? `AND (t.title LIKE @q ESCAPE '\\' OR t.artist LIKE @q ESCAPE '\\' OR t.album LIKE @q ESCAPE '\\')` : '';
  const page = limit ? 'LIMIT @limit OFFSET @offset' : '';
  const rows = db.prepare(`
    SELECT t.*,
      (t.file_path IS NOT NULL) AS available,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = @uid AND f.track_id = t.deezer_id) AS favorite,
      (SELECT d.status FROM downloads d
         WHERE (d.kind = 'track' AND d.deezer_id = t.deezer_id)
            OR (d.kind = 'album' AND d.deezer_id = t.album_id)
         ORDER BY d.created_at DESC LIMIT 1) AS download_status
    FROM tracks t
    WHERE (t.file_path IS NOT NULL
       OR EXISTS (SELECT 1 FROM downloads d
            WHERE d.status IN ('searching', 'downloading', 'importing')
              AND ((d.kind = 'track' AND d.deezer_id = t.deezer_id)
                OR (d.kind = 'album' AND d.deezer_id = t.album_id))))
      ${filter}
    ORDER BY (t.file_path IS NOT NULL) DESC, t.added_at DESC
    ${page}
  `).all({ uid: req.user.id, ...(q ? { q: `%${likeEscape(q)}%` } : {}), ...(limit ? { limit, offset } : {}) });
  res.json(rows);
});

// Bulk track lookup by id — used to rehydrate a persisted play queue.
api.get('/tracks', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(x => parseInt(x, 10)).filter(Number.isFinite).slice(0, 500);
  if (!ids.length) return res.json([]);
  const stmt = db.prepare('SELECT *, (file_path IS NOT NULL) AS available FROM tracks WHERE deezer_id = ?');
  // Preserve the requested order (it IS the queue order).
  res.json(ids.map(id => stmt.get(id)).filter(Boolean));
});

// Albums actually present in the library (at least one track on disk), with
// their cover and how many of their tracks we have — computed in SQL so the
// albums tab doesn't need the whole track list.
api.get('/library/albums', (req, res) => {
  res.json(db.prepare(`
    SELECT t.album_id AS id, MAX(t.album) AS title, MAX(t.artist) AS artist,
           MAX(t.artist_id) AS artist_id, MAX(t.cover) AS cover, COUNT(*) AS count
    FROM tracks t
    WHERE t.file_path IS NOT NULL AND t.album_id IS NOT NULL
    GROUP BY t.album_id
    ORDER BY MAX(t.added_at) DESC
  `).all());
});

// Artists present in the library, with their real Deezer artist picture (the
// track cover is the album art, which isn't the artist photo). Pictures are read
// from the local `artists` cache; only the ones we've never seen are fetched
// from Deezer (bounded concurrency) and then cached, so a large library doesn't
// fan out hundreds of simultaneous Deezer requests on every load.
api.get('/library/artists', async (req, res) => {
  const rows = db.prepare(`
    SELECT t.artist_id AS id, t.artist AS name, COUNT(*) AS count, a.picture AS picture
    FROM tracks t LEFT JOIN artists a ON a.id = t.artist_id
    WHERE t.file_path IS NOT NULL AND t.artist_id IS NOT NULL
    GROUP BY t.artist_id ORDER BY count DESC, t.artist`).all();

  const missing = rows.filter(r => !r.picture);
  await mapLimit(missing, 5, async r => {
    try {
      const a = await deezerGet(`artist/${r.id}`);
      r.picture = a.picture_medium || a.picture || null;
      upsertArtist(r.id, r.name, r.picture);
    } catch { /* leave it null; retried on a later load */ }
  });
  res.json(rows.map(r => ({ id: r.id, name: r.name, count: r.count, picture: r.picture })));
});


/* ----------------------------------------------------------- Delete files */
// Promote an already-downloaded track into the shared Library view. A track can
// be on disk but `in_library = 0` (it only came along inside an album download,
// or surfaced via another user's activity); this marks it as a first-class
// library item. Only works for tracks whose audio actually exists.
api.put('/library/:trackId', (req, res) => {
  const id = parseInt(req.params.trackId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid track id' });
  const row = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Track not found' });
  if (!row.file_path) return res.status(400).json({ error: 'Track is not on the server yet' });
  db.prepare('UPDATE tracks SET in_library = 1 WHERE deezer_id = ?').run(id);
  res.json({ ok: true });
});

/* --------------------------------------------------- Import existing files */
// Scan the root folder for audio files Musicarr doesn't know about, match each
// to a Deezer track by tags (title/artist/duration), and link matches into the
// catalog in place. Runs in the background; poll GET /library/scan (or listen
// for 'scan' SSE events) for progress. Admin-only: it touches the shared library.
api.post('/library/scan', requireAdmin, (req, res) => {
  try {
    res.json({ ...startImportScan() });
  } catch (e) {
    res.status(409).json({ error: String(e.message || e) });
  }
});

api.get('/library/scan', requireAdmin, (req, res) => {
  res.json({ ...scanState });
});

/* --------------------------------------------------------- Library health */
// One admin view of everything that otherwise only lives in logs: tracks whose
// file vanished, likely-upgradable low-bitrate files, duplicate recordings,
// files the import scan couldn't match, and Soulseek peers currently blocked
// for repeated failures.
const LOW_BITRATE_KBPS = 200; // non-lossless below this is flagged as upgradable

api.get('/library/health', requireAdmin, (req, res) => {
  const onDisk = db.prepare(`
    SELECT deezer_id, title, artist, album, cover, duration, file_path
    FROM tracks WHERE file_path IS NOT NULL
  `).all();

  const missing = [];
  const lowBitrate = [];
  let totalBytes = 0;
  for (const t of onDisk) {
    let stat = null;
    try { stat = fs.statSync(t.file_path); } catch { /* vanished */ }
    if (!stat) { missing.push(t); continue; }
    totalBytes += stat.size;
    // Estimated bitrate from size/duration — cheap (no tag parsing) and close
    // enough to spot 128kbps MP3s. Lossless formats are never "low".
    const lossless = /\.(flac|wav)$/i.test(t.file_path);
    if (!lossless && t.duration > 0) {
      const kbps = Math.round((stat.size * 8) / t.duration / 1000);
      if (kbps > 0 && kbps < LOW_BITRATE_KBPS) lowBitrate.push({ ...t, kbps });
    }
  }
  lowBitrate.sort((a, b) => a.kbps - b.kbps);

  // Same song imported twice under different Deezer ids (e.g. album + single).
  const duplicates = db.prepare(`
    SELECT LOWER(artist) || '|' || LOWER(title) AS k,
           GROUP_CONCAT(deezer_id) AS ids, MAX(artist) AS artist, MAX(title) AS title,
           COUNT(*) AS n
    FROM tracks WHERE file_path IS NOT NULL
    GROUP BY k HAVING n > 1 ORDER BY n DESC, artist
  `).all().map(d => ({ artist: d.artist, title: d.title, count: d.n, ids: d.ids.split(',').map(Number) }));

  res.json({
    tracks: onDisk.length,
    inLibrary: db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE file_path IS NOT NULL AND in_library = 1').get().n,
    totalBytes,
    missing,
    lowBitrate: lowBitrate.slice(0, 200),
    duplicates: duplicates.slice(0, 100),
    unmatched: scanState.unmatched || [],
    blockedPeers: blockedPeers(),
  });
});

// Drop rows whose file vanished (and relink any that reappeared) — the same
// reconcile that runs on boot, exposed as the health page's "Prune" action.
api.post('/library/health/prune', requireAdmin, (req, res) => {
  res.json(scanLibrary());
});

// Give a blocked peer another chance.
api.delete('/library/health/peers/:username', requireAdmin, (req, res) => {
  clearPeerStrikes(String(req.params.username || ''));
  res.json({ ok: true });
});

// Permanently remove a track's audio from disk (both the library hardlink and
// the original slskd download). Destructive + affects the shared library, so
// it's admin-only.
api.delete('/library/:trackId', requireAdmin, (req, res) => {
  const id = parseInt(req.params.trackId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid track id' });
  const result = deleteTrackFile(id);
  if (result.notFound) return res.status(404).json({ error: 'Track not found' });
  res.json({ ok: true, removed: result.removed.length });
});

}
