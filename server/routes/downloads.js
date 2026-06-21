import fs from 'node:fs';
import { db } from '../db.js';
import { deezerGet } from '../sources.js';
import { queueDownload } from '../downloader.js';
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

api.delete('/downloads/:id', (req, res) => {
  // Admins can dismiss any download; users only their own.
  if (req.user.is_admin) db.prepare('DELETE FROM downloads WHERE id = ?').run(req.params.id);
  else db.prepare('DELETE FROM downloads WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

}
