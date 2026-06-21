import { db, upsertArtist } from '../db.js';
import { requireAdmin } from '../auth.js';
import { deezerGet } from '../sources.js';
import { deleteTrackFile } from '../downloader.js';
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
api.get('/library', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*,
      (t.file_path IS NOT NULL) AS available,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.track_id = t.deezer_id) AS favorite,
      (SELECT d.status FROM downloads d
         WHERE (d.kind = 'track' AND d.deezer_id = t.deezer_id)
            OR (d.kind = 'album' AND d.deezer_id = t.album_id)
         ORDER BY d.created_at DESC LIMIT 1) AS download_status
    FROM tracks t
    WHERE t.file_path IS NOT NULL
       OR EXISTS (SELECT 1 FROM downloads d
            WHERE d.status IN ('searching', 'downloading', 'importing')
              AND ((d.kind = 'track' AND d.deezer_id = t.deezer_id)
                OR (d.kind = 'album' AND d.deezer_id = t.album_id)))
    ORDER BY (t.file_path IS NOT NULL) DESC, t.added_at DESC
  `).all(req.user.id);
  res.json(rows);
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
