import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, config, getSetting, setSetting, upsertTrack, trackRowFromDeezer } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';
import { deezerGet, testSlskd } from './sources.js';
import { queueDownload, deleteTrackFile } from './downloader.js';
import { logger } from './log.js';

const log = logger('api');

export const api = Router();
api.use(requireAuth);

/* -------------------------------------------------------------- Settings */
// Settings work like Radarr/Sonarr: edited from the UI, stored in the DB, and
// persisted across reboots. The matching env vars only seed first-run defaults.

// Current effective config (what the server is actually using right now).
function currentSettings() {
  return {
    root_folder: config.musicDir,
    slskd_url: config.slskdUrl,
    slskd_api_key: config.slskdApiKey,
    slskd_download_dir: config.slskdDownloadDir,
    slskd_enabled: config.slskdEnabled,
  };
}

api.get('/settings', requireAdmin, (req, res) => {
  res.json(currentSettings());
});

api.put('/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  const str = v => (v ?? '').toString().trim();
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  const isHttpUrl = v => /^https?:\/\/\S+$/i.test(v);

  try {
    // --- Library root folder (created and write-checked) ---
    if (has('root_folder')) {
      const folder = str(b.root_folder);
      if (!folder) throw new Error('Root folder is required');
      if (!path.isAbsolute(folder)) throw new Error('Root folder must be an absolute path (e.g. /music)');
      const resolved = path.resolve(folder);
      try {
        fs.mkdirSync(resolved, { recursive: true });
        fs.accessSync(resolved, fs.constants.W_OK);
      } catch (e) {
        throw new Error(`Root folder is not writable: ${e.message}`);
      }
      setSetting('root_folder', resolved);
    }

    // --- slskd (Soulseek) ---
    if (has('slskd_url')) {
      const url = str(b.slskd_url);
      if (url && !isHttpUrl(url)) throw new Error('slskd URL must start with http:// or https://');
      setSetting('slskd_url', url.replace(/\/$/, ''));
    }
    if (has('slskd_api_key')) setSetting('slskd_api_key', str(b.slskd_api_key));
    if (has('slskd_download_dir')) {
      const dir = str(b.slskd_download_dir);
      if (dir && !path.isAbsolute(dir)) throw new Error('slskd download directory must be an absolute path');
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.accessSync(dir, fs.constants.R_OK);
        } catch (e) {
          throw new Error(`slskd download directory is not accessible from Musicarr: ${e.message}`);
        }
      }
      setSetting('slskd_download_dir', dir);
    }
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  res.json(currentSettings());
});

// Test a connection with the values being entered (before saving them).
api.post('/settings/test', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    if (b.section === 'slskd') {
      const { serverState } = await testSlskd({ url: b.slskd_url, apiKey: b.slskd_api_key });
      return res.json({ ok: true, detail: `Soulseek server: ${serverState}` });
    }
    return res.status(400).json({ error: 'Unknown section' });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

/* ----------------------------------------------------------- Library view */
// A track is "available" to a user if its file exists on disk. Ownership is
// implicit: any signed-in user can play any imported file (shared library),
// but favorites/playlists are per-user.
function trackWithFlags(userId) {
  return db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available,
           EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.track_id = t.deezer_id) AS favorite
    FROM tracks t WHERE t.deezer_id = ?
  `).pluck(false);
}

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

/* --------------------------------------------------------------- Search */
// Unified search: returns artists, albums and tracks from Deezer, each tagged
// with whether we already have the file locally.
api.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ artists: [], albums: [], tracks: [] });
  try {
    const [artistsR, albumsR, tracksR] = await Promise.all([
      deezerGet(`search/artist?q=${encodeURIComponent(q)}&limit=8`),
      deezerGet(`search/album?q=${encodeURIComponent(q)}&limit=12`),
      deezerGet(`search/track?q=${encodeURIComponent(q)}&limit=25`),
    ]);
    const haveAlbum = db.prepare('SELECT 1 FROM tracks WHERE album_id = ? AND file_path IS NOT NULL LIMIT 1');
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    res.json({
      artists: (artistsR.data || []).map(a => ({ id: a.id, name: a.name, picture: a.picture_medium, nb_fan: a.nb_fan })),
      albums: (albumsR.data || []).map(a => ({
        id: a.id, title: a.title, artist: a.artist?.name, artist_id: a.artist?.id,
        cover: a.cover_medium, nb_tracks: a.nb_tracks,
        available: !!haveAlbum.get(a.id),
      })),
      tracks: (tracksR.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
        duration: t.duration, available: !!haveTrack.get(t.id)?.file_path,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* -------------------------------------------------- Browse (Deezer proxy) */
api.get('/artist/:id', async (req, res) => {
  try {
    const [artist, top, albums, related] = await Promise.all([
      deezerGet(`artist/${req.params.id}`),
      deezerGet(`artist/${req.params.id}/top?limit=10`),
      deezerGet(`artist/${req.params.id}/albums?limit=50`),
      deezerGet(`artist/${req.params.id}/related?limit=12`),
    ]);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    const haveAlbum = db.prepare('SELECT 1 FROM tracks WHERE album_id = ? AND file_path IS NOT NULL LIMIT 1');
    res.json({
      artist: { id: artist.id, name: artist.name, picture: artist.picture_xl || artist.picture_big, nb_fan: artist.nb_fan },
      top: (top.data || []).map(t => ({
        id: t.id, title: t.title, artist: artist.name, artist_id: artist.id,
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium, duration: t.duration,
        available: !!haveTrack.get(t.id)?.file_path,
      })),
      albums: (albums.data || []).map(a => ({
        id: a.id, title: a.title, cover: a.cover_medium, nb_tracks: a.nb_tracks,
        release_date: a.release_date, record_type: a.record_type,
        available: !!haveAlbum.get(a.id),
      })),
      related: (related.data || []).map(a => ({ id: a.id, name: a.name, picture: a.picture_medium })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

api.get('/album/:id', async (req, res) => {
  try {
    const album = await deezerGet(`album/${req.params.id}`);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    res.json({
      id: album.id, title: album.title, artist: album.artist?.name, artist_id: album.artist?.id,
      cover: album.cover_big || album.cover_medium, release_date: album.release_date,
      nb_tracks: album.nb_tracks,
      tracks: (album.tracks?.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
        duration: t.duration, track_position: t.track_position,
        available: !!haveTrack.get(t.id)?.file_path,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ------------------------------------------------------------- Home feed */
api.get('/home', async (req, res) => {
  try {
    const [tracks, albums, artists, playlists] = await Promise.all([
      deezerGet('chart/0/tracks?limit=20'),
      deezerGet('chart/0/albums?limit=20'),
      deezerGet('chart/0/artists?limit=20'),
      deezerGet('chart/0/playlists?limit=12').catch(() => ({ data: [] })),
    ]);
    res.json({
      tracks: (tracks.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium, duration: t.duration,
      })),
      albums: (albums.data || []).map(a => ({ id: a.id, title: a.title, artist: a.artist?.name, artist_id: a.artist?.id, cover: a.cover_medium })),
      artists: (artists.data || []).map(a => ({ id: a.id, name: a.name, picture: a.picture_medium })),
      playlists: (playlists.data || []).map(p => ({
        id: p.id, title: p.title, cover: p.picture_medium || p.picture,
        nb_tracks: p.nb_tracks, by: p.user?.name || 'Deezer',
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Preview a Deezer playlist (its tracks) before importing it.
api.get('/deezer-playlist/:id', async (req, res) => {
  try {
    const pl = await deezerGet(`playlist/${req.params.id}`);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    res.json({
      id: pl.id, title: pl.title, cover: pl.picture_big || pl.picture_medium,
      by: pl.creator?.name || pl.user?.name || 'Deezer', nb_tracks: pl.nb_tracks,
      tracks: (pl.tracks?.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
        duration: t.duration, available: !!haveTrack.get(t.id)?.file_path,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ------------------------------------------------------------- Explore */
// Music genres for the Explore tab.
api.get('/explore', async (req, res) => {
  try {
    const g = await deezerGet('genre');
    res.json({
      genres: (g.data || [])
        .filter(x => x.id !== 0) // "All"
        .map(x => ({ id: x.id, name: x.name, picture: x.picture_medium || x.picture })),
      moods: MOODS.map(m => ({ slug: m.slug, name: m.name })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Moods don't exist as a Deezer API primitive, so each maps to a search term
// for curated playlists; the top playlist's tracks give the "songs for <mood>".
const MOODS = [
  { slug: 'happy', name: 'Happy', q: 'happy' },
  { slug: 'chill', name: 'Chill', q: 'chill' },
  { slug: 'sad', name: 'Melancholy', q: 'sad songs' },
  { slug: 'energetic', name: 'Energetic', q: 'workout energy' },
  { slug: 'romantic', name: 'Romantic', q: 'love songs' },
  { slug: 'focus', name: 'Focus', q: 'focus concentration' },
  { slug: 'party', name: 'Party', q: 'party hits' },
  { slug: 'sleep', name: 'Sleep', q: 'sleep calm' },
];

api.get('/mood/:slug', async (req, res) => {
  const mood = MOODS.find(m => m.slug === req.params.slug.toLowerCase());
  const q = mood?.q || req.params.slug;
  try {
    const pl = await deezerGet(`search/playlist?q=${encodeURIComponent(q)}&limit=12`);
    const playlists = (pl.data || []).filter(p => p?.id).map(p => ({
      id: p.id, title: p.title, cover: p.picture_medium || p.picture,
      nb_tracks: p.nb_tracks, by: p.user?.name || 'Deezer',
    }));
    // Songs for the mood = the tracks of the top matching playlist.
    let tracks = [];
    if (playlists[0]) {
      const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
      const full = await deezerGet(`playlist/${playlists[0].id}`);
      tracks = (full.tracks?.data || []).slice(0, 40).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
        duration: t.duration, available: !!haveTrack.get(t.id)?.file_path,
      }));
    }
    res.json({ slug: mood?.slug || req.params.slug, name: mood?.name || q, playlists, tracks });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Suggestions for one genre: Deezer's chart scoped to the genre id gives
// tracks / albums / artists / playlists for it.
api.get('/genre/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [genre, chart] = await Promise.all([
      deezerGet(`genre/${id}`).catch(() => ({})),
      deezerGet(`chart/${id}`),
    ]);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    const haveAlbum = db.prepare('SELECT 1 FROM tracks WHERE album_id = ? AND file_path IS NOT NULL LIMIT 1');
    res.json({
      id, name: genre.name || 'Genre',
      artists: (chart.artists?.data || []).map(a => ({ id: a.id, name: a.name, picture: a.picture_medium })),
      albums: (chart.albums?.data || []).map(a => ({
        id: a.id, title: a.title, artist: a.artist?.name, artist_id: a.artist?.id,
        cover: a.cover_medium, available: !!haveAlbum.get(a.id),
      })),
      playlists: (chart.playlists?.data || []).map(p => ({
        id: p.id, title: p.title, cover: p.picture_medium || p.picture,
        nb_tracks: p.nb_tracks, by: p.user?.name || 'Deezer',
      })),
      tracks: (chart.tracks?.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
        duration: t.duration, available: !!haveTrack.get(t.id)?.file_path,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ----------------------------------------------------------- Downloads */
api.post('/download', async (req, res) => {
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

/* ----------------------------------------------------------- Favorites */
api.get('/favorites', (req, res) => {
  res.json(db.prepare(`
    SELECT t.* FROM favorites f JOIN tracks t ON t.deezer_id = f.track_id
    WHERE f.user_id = ? ORDER BY f.added_at DESC
  `).all(req.user.id));
});

// A track must exist in the catalog before it can be favorited (FK). Search
// results aren't in the catalog yet, so accept the track metadata in the body
// and upsert it first — otherwise the favorite would be silently dropped.
function ensureTrack(trackId, body) {
  const id = parseInt(trackId, 10);
  if (!Number.isFinite(id)) return null;
  const exists = db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id);
  // The client sends a flat track shape (artist is a string, not a Deezer
  // object), so map it directly rather than via trackRowFromDeezer.
  if (!exists && body && body.title) {
    upsertTrack({
      deezer_id: id,
      title: body.title,
      artist: body.artist || 'Unknown',
      artist_id: body.artist_id || null,
      album: body.album || null,
      album_id: body.album_id || null,
      track_position: body.track_position || null,
      duration: body.duration || null,
      cover: body.cover || null,
    });
  }
  return db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id) ? id : null;
}

api.put('/favorites/:trackId', (req, res) => {
  const id = ensureTrack(req.params.trackId, req.body);
  if (!id) return res.status(400).json({ error: 'Unknown track — open it once so its details are known, then favorite it' });
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ ok: true });
});

api.delete('/favorites/:trackId', (req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?').run(req.user.id, req.params.trackId);
  res.json({ ok: true });
});

/* ----------------------------------------------------------- Playlists */
api.get('/playlists', (req, res) => {
  const lists = db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at').all(req.user.id);
  for (const l of lists) {
    l.count = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(l.id).n;
    l.cover = db.prepare(`
      SELECT t.cover FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
      WHERE pi.playlist_id = ? AND t.cover IS NOT NULL ORDER BY pi.position LIMIT 1
    `).get(l.id)?.cover || null;
  }
  res.json(lists);
});

api.post('/playlists', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(req.user.id, name);
  res.json({ id: info.lastInsertRowid, name });
});

// Import a Deezer playlist into the user's collection: create (or refresh) a
// local playlist with the same tracks, then queue downloads for the tracks we
// don't have on disk yet so the playlist becomes fully playable. Missing
// tracks are queued as individual Soulseek downloads.
const IMPORT_QUEUE_CAP = 50; // tracks per run; re-import to continue
api.post('/playlists/import-deezer', async (req, res) => {
  const deezerId = parseInt(req.body?.deezer_playlist_id, 10);
  if (!deezerId) return res.status(400).json({ error: 'deezer_playlist_id required' });
  try {
    const pl = await deezerGet(`playlist/${deezerId}`);
    const tracks = (pl.tracks?.data || []).filter(t => t?.id && t?.title);
    if (!tracks.length) return res.status(400).json({ error: 'Playlist has no tracks' });

    const rows = tracks.map(t => trackRowFromDeezer(t));
    rows.forEach(upsertTrack);

    // Reuse a same-named playlist (re-import refreshes it), else create one.
    const name = (pl.title || `Deezer playlist ${deezerId}`).trim();
    let list = db.prepare('SELECT * FROM playlists WHERE user_id = ? AND name = ?').get(req.user.id, name);
    if (!list) {
      const info = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(req.user.id, name);
      list = { id: info.lastInsertRowid, name };
    }
    db.transaction(() => {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(list.id);
      const ins = db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, position, track_id) VALUES (?, ?, ?)');
      rows.forEach((r, i) => ins.run(list.id, i, r.deezer_id));
    })();

    // Queue what's missing — slskd grabs single tracks natively, so each
    // missing song is its own download.
    const haveFile = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    const missing = rows.filter(r => {
      const f = haveFile.get(r.deezer_id)?.file_path;
      return !(f && fs.existsSync(f));
    });
    let queued = 0;
    for (const m of missing) {
      if (queued >= IMPORT_QUEUE_CAP) break;
      queueDownload(req.user.id, 'track', m.deezer_id, `${m.artist} – ${m.title}`, m.cover);
      queued++;
    }
    log.info(`playlist import "${name}": ${rows.length} tracks, ${missing.length} missing, ${queued} download(s) queued`);
    res.json({
      id: list.id, name, total: rows.length,
      have: rows.length - missing.length, missing: missing.length,
      queued, remaining: Math.max(0, missing.length - queued),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

api.get('/playlists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  list.tracks = db.prepare(`
    SELECT t.*, pi.position FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
    WHERE pi.playlist_id = ? ORDER BY pi.position
  `).all(list.id);
  res.json(list);
});

api.delete('/playlists/:id', (req, res) => {
  db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

api.post('/playlists/:id/tracks', (req, res) => {
  const list = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  const trackId = ensureTrack(req.body?.track_id, req.body?.track);
  if (!trackId) return res.status(400).json({ error: 'Unknown track — open it once so its details are known, then add it' });
  const pos = (db.prepare('SELECT MAX(position) AS m FROM playlist_items WHERE playlist_id = ?').get(list.id).m ?? -1) + 1;
  db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, position, track_id) VALUES (?, ?, ?)').run(list.id, pos, trackId);
  res.json({ ok: true });
});

api.delete('/playlists/:id/tracks/:trackId', (req, res) => {
  const list = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?').run(list.id, req.params.trackId);
  res.json({ ok: true });
});

/* --------------------------------------------------- Plays / history / recs */
// Map a Deezer track object to our wire shape, flagging on-disk availability.
const haveTrackStmt = () => db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
function mapTrack(t, have) {
  return {
    id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id,
    album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
    duration: t.duration, available: !!have.get(t.id)?.file_path,
  };
}

// Record that the user played a track (drives history + recommendations).
api.post('/plays', (req, res) => {
  const id = parseInt(req.body?.track_id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'track_id required' });
  // Only log tracks we actually know about; ignore unknown ids quietly.
  if (db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id)) {
    db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(req.user.id, id);
  }
  res.json({ ok: true });
});

// Recently played, most-recent-first, de-duplicated by track.
api.get('/history', (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, MAX(p.played_at) AS last_played
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE p.user_id = ?
    GROUP BY p.track_id ORDER BY last_played DESC LIMIT 30
  `).all(req.user.id));
});

// "You might like": seed from the user's favorites + listening history, pull
// related artists from Deezer and surface their popular tracks (those not in
// the seed set). Falls back to the global chart for brand-new accounts.
api.get('/recommendations', async (req, res) => {
  try {
    const have = haveTrackStmt();
    const seeds = db.prepare(`
      SELECT t.artist_id, t.artist, COUNT(*) AS n FROM (
        SELECT track_id AS tid FROM favorites WHERE user_id = @u
        UNION ALL SELECT track_id AS tid FROM plays WHERE user_id = @u
      ) x JOIN tracks t ON t.deezer_id = x.tid
      WHERE t.artist_id IS NOT NULL
      GROUP BY t.artist_id ORDER BY n DESC LIMIT 4
    `).all({ u: req.user.id });

    if (!seeds.length) {
      const chart = await deezerGet('chart/0/tracks?limit=25');
      return res.json({ personalized: false, basedOn: [], artists: [], tracks: (chart.data || []).map(t => mapTrack(t, have)) });
    }

    // Gather related artists from each seed (cached), de-duplicated and
    // excluding artists the user already listens to.
    const seedIds = new Set(seeds.map(s => s.artist_id));
    const relMap = new Map();
    const relatedLists = await Promise.all(seeds.map(s => deezerGet(`artist/${s.artist_id}/related?limit=8`).catch(() => ({ data: [] }))));
    for (const rl of relatedLists) for (const a of (rl.data || [])) {
      if (!seedIds.has(a.id) && !relMap.has(a.id)) relMap.set(a.id, a);
    }
    const related = [...relMap.values()].slice(0, 12);

    // Popular tracks from a handful of those related artists.
    const picks = related.slice(0, 6);
    const tops = await Promise.all(picks.map(a => deezerGet(`artist/${a.id}/top?limit=5`).catch(() => ({ data: [] }))));
    const seen = new Set();
    const tracks = [];
    for (const tr of tops) for (const t of (tr.data || [])) {
      if (seen.has(t.id)) continue; seen.add(t.id);
      tracks.push(mapTrack(t, have));
    }
    res.json({
      personalized: true,
      basedOn: seeds.map(s => ({ id: s.artist_id, name: s.artist })),
      artists: related.map(a => ({ id: a.id, name: a.name, picture: a.picture_medium })),
      tracks,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Radio: an endless-style queue seeded from a track or an artist. Because we
// can only play files we have on disk, the client pre-downloads upcoming
// tracks; this endpoint just supplies the ordered candidate list.
api.get('/radio', async (req, res) => {
  const seed = String(req.query.seed || '');
  const m = /^(track|artist):(\d+)$/.exec(seed);
  if (!m) return res.status(400).json({ error: 'seed must be "track:<id>" or "artist:<id>"' });
  const [, kind, rawId] = m;
  try {
    const have = haveTrackStmt();
    let artistId = parseInt(rawId, 10);
    const out = [];
    if (kind === 'track') {
      const t = await deezerGet(`track/${rawId}`);
      artistId = t.artist?.id || artistId;
      out.push(mapTrack(t, have)); // start with the seed track itself
    }
    // Deezer's artist radio is a ready-made "if you like this, here's more" flow.
    const radio = await deezerGet(`artist/${artistId}/radio`);
    const seen = new Set(out.map(t => t.id));
    for (const t of (radio.data || [])) {
      if (seen.has(t.id)) continue; seen.add(t.id);
      out.push(mapTrack(t, have));
    }
    res.json({ seed, tracks: out });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Lightweight availability/status lookup for a set of track ids, so the radio
// pre-fetcher can tell when a queued download has landed on disk.
api.get('/track-status', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(x => parseInt(x, 10)).filter(Number.isFinite).slice(0, 100);
  if (!ids.length) return res.json({});
  const out = {};
  const fileStmt = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
  const statusStmt = db.prepare(`
    SELECT status FROM downloads
    WHERE (kind = 'track' AND deezer_id = ?) OR (kind = 'album' AND deezer_id = (SELECT album_id FROM tracks WHERE deezer_id = ?))
    ORDER BY created_at DESC LIMIT 1`);
  for (const id of ids) {
    out[id] = { available: !!fileStmt.get(id)?.file_path, status: statusStmt.get(id, id)?.status || null };
  }
  res.json(out);
});

/* ----------------------------------------------------------- Delete files */
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
