import fs from 'node:fs';
import { db } from '../db.js';
import { deezerGet } from '../sources.js';
import { queueDownload, cancelDownloadTransfers, retryDownload } from '../downloader.js';
import { rateLimit } from '../ratelimit.js';
export function registerDownloads(api) {
  const downloadLimit = rateLimit({ windowMs: 60_000, max: 60 });
/* ----------------------------------------------------------- Downloads */
api.post('/download', downloadLimit, async (req, res) => {
  const { kind } = req.body || {};
  const deezer_id = parseInt(req.body?.deezer_id, 10);
  if (!['album', 'track'].includes(kind) || !Number.isFinite(deezer_id) || deezer_id <= 0) {
    return res.status(400).json({ error: 'kind (album|track) and a numeric deezer_id are required' });
  }
  try {
    // Dedupe: a single track already on disk needs no download.
    if (kind === 'track') {
      const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(deezer_id);
      if (have?.file_path && fs.existsSync(have.file_path)) {
        return res.json({ alreadyHave: true });
      }
    }
    let label, cover;
    if (kind === 'album') {
      const a = await deezerGet(`album/${deezer_id}`);
      label = `${a.artist?.name} – ${a.title}`; cover = a.cover_medium;
    } else {
      const t = await deezerGet(`track/${deezer_id}`);
      label = `${t.artist?.name} – ${t.title}`; cover = t.album?.cover_medium;
    }
    const id = queueDownload(req.user.id, kind, deezer_id, label, cover);
    res.json({ id });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Admins see everyone's downloads (with the requesting user's name); regular
// users see only their own.
api.get('/downloads', (req, res) => {
  const rows = req.user.is_admin
    ? db.prepare(`
        SELECT d.*, u.username FROM downloads d
        LEFT JOIN users u ON u.id = d.user_id
        ORDER BY d.created_at DESC LIMIT 200`).all()
    : db.prepare(`SELECT * FROM downloads WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.user.id);
  res.json(rows);
});

// Find a download the requester is allowed to act on (admins: any; users: own).
function ownedDownload(req) {
  const id = parseInt(req.params.id, 10);
  return req.user.is_admin
    ? db.prepare('SELECT * FROM downloads WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM downloads WHERE id = ? AND user_id = ?').get(id, req.user.id);
}

api.delete('/downloads/:id', async (req, res) => {
  // Dismissing a download also cancels any in-flight slskd transfer so it stops
  // pulling files we no longer want.
  const dl = ownedDownload(req);
  if (dl) {
    await cancelDownloadTransfers(dl);
    db.prepare('DELETE FROM downloads WHERE id = ?').run(dl.id);
  }
  res.json({ ok: true });
});

// Manually retry a failed download (status error/not_found) from scratch.
api.post('/downloads/:id/retry', (req, res) => {
  const dl = ownedDownload(req);
  if (!dl) return res.status(404).json({ error: 'Download not found' });
  if (dl.status !== 'error' && dl.status !== 'not_found') {
    return res.status(400).json({ error: 'Only failed downloads can be retried' });
  }
  retryDownload(dl);
  res.json({ ok: true, status: 'searching' });
});

}
