import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, config, setSetting, upsertTrack, upsertArtist, trackRowFromDeezer, avatarPath } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';
import { deezerGet, testSlskd } from './sources.js';
import { queueDownload, deleteTrackFile, cleanupStaleTracks } from './downloader.js';
import { seedSeenAlbums } from './releases.js';
import { createCache } from './cache.js';
import { rateLimit } from './ratelimit.js';
import { logger } from './log.js';

const log = logger('api');

// Per-user throttles for the endpoints that fan out to Deezer/slskd, so one
// client can't stampede those upstreams. Tuned well above normal interactive
// use; only runaway scripts hit them.
const searchLimit = rateLimit({ windowMs: 60_000, max: 60 });
const downloadLimit = rateLimit({ windowMs: 60_000, max: 60 });
const importLimit = rateLimit({ windowMs: 5 * 60_000, max: 20 });

// Run async `fn` over `items` with at most `limit` calls in flight at once, so a
// big list doesn't fire every request simultaneously (and get rate-limited).
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const worker = async () => { while (queue.length) await fn(queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

export const api = Router();
api.use(requireAuth);

/* -------------------------------------------------------------- Settings */
// Settings work like Radarr/Sonarr: edited from the UI, stored in the DB, and
// persisted across reboots. The matching env vars only seed first-run defaults.

// Current effective config (what the server is actually using right now).
function currentSettings() {
  // The slskd API key is a secret: never send it back to the browser. We only
  // report whether one is set (so the UI can show "configured") plus a short
  // masked hint of the tail for recognisability. Saving an empty value leaves
  // the stored key unchanged; sending a new value replaces it.
  const key = config.slskdApiKey || '';
  return {
    root_folder: config.musicDir,
    slskd_url: config.slskdUrl,
    slskd_api_key: '',
    slskd_api_key_set: !!key,
    slskd_api_key_hint: key ? `••••${key.slice(-4)}` : '',
    slskd_download_dir: config.slskdDownloadDir,
    slskd_enabled: config.slskdEnabled,
    cleanup_enabled: config.autoCleanupEnabled,
    cleanup_after_days: config.cleanupAfterDays,
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
    // The UI never receives the stored key back, so an empty value here means
    // "leave it as-is"; only a non-empty value replaces it. (Clearing the key is
    // done from the dedicated control that sends slskd_api_key_clear.)
    if (has('slskd_api_key') && str(b.slskd_api_key)) setSetting('slskd_api_key', str(b.slskd_api_key));
    if (b.slskd_api_key_clear === true) setSetting('slskd_api_key', '');
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

    // --- Auto-cleanup (library maintenance) ---
    if (has('cleanup_enabled')) setSetting('cleanup_enabled', b.cleanup_enabled ? '1' : '0');
    if (has('cleanup_after_days')) {
      const n = parseInt(b.cleanup_after_days, 10);
      if (Number.isNaN(n) || n < 0) throw new Error('Cleanup period must be 0 or more days');
      setSetting('cleanup_after_days', String(n));
    }
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  res.json(currentSettings());
});

// Run the stale-track cleanup immediately (admin), returning how many were removed.
api.post('/settings/cleanup-now', requireAdmin, async (req, res) => {
  try {
    const removed = await cleanupStaleTracks();
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Test a connection with the values being entered (before saving them).
api.post('/settings/test', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    if (b.section === 'slskd') {
      // Fall back to the stored URL/key when the form left them blank (the key is
      // never sent back to the browser, so "test" on an unchanged key must reuse it).
      const { serverState } = await testSlskd({
        url: (b.slskd_url || '').trim() || config.slskdUrl,
        apiKey: (b.slskd_api_key || '').trim() || config.slskdApiKey,
      });
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

/* --------------------------------------------------------------- Search */
// Unified search: returns artists, albums and tracks from Deezer, each tagged
// with whether we already have the file locally.
api.get('/search', searchLimit, async (req, res) => {
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
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
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
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid artist id' });
  try {
    const [artist, top, albums, related] = await Promise.all([
      deezerGet(`artist/${id}`),
      deezerGet(`artist/${id}/top?limit=10`),
      deezerGet(`artist/${id}/albums?limit=50`),
      deezerGet(`artist/${id}/related?limit=12`),
    ]);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    const haveAlbum = db.prepare('SELECT 1 FROM tracks WHERE album_id = ? AND file_path IS NOT NULL LIMIT 1');
    const following = !!db.prepare('SELECT 1 FROM followed_artists WHERE user_id = ? AND artist_id = ?')
      .get(req.user.id, id);
    // Warm the artist-picture cache so the library view doesn't have to fetch it.
    upsertArtist(artist.id, artist.name, artist.picture_medium || artist.picture_big || artist.picture_xl || artist.picture || null);
    for (const a of (related.data || [])) upsertArtist(a.id, a.name, a.picture_medium || a.picture || null);
    res.json({
      artist: { id: artist.id, name: artist.name, picture: artist.picture_xl || artist.picture_big, nb_fan: artist.nb_fan },
      following,
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

/* ----------------------------------------------- Followed artists (new releases) */
// Follow an artist to have new releases auto-downloaded. Listing/unfollowing is
// per-user; the actual release watcher runs server-wide (see releases.js).
api.get('/following', (req, res) => {
  res.json(db.prepare(`
    SELECT artist_id AS id, artist_name AS name, artist_picture AS picture, created_at
    FROM followed_artists WHERE user_id = ? ORDER BY artist_name COLLATE NOCASE
  `).all(req.user.id));
});

api.put('/following/:artistId', async (req, res) => {
  const id = parseInt(req.params.artistId, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid artist id' });
  try {
    const a = await deezerGet(`artist/${id}`);
    if (!a?.name) return res.status(404).json({ error: 'Unknown artist' });
    const picture = a.picture_medium || a.picture_big || null;
    upsertArtist(id, a.name, picture); // warm the library-view picture cache
    // Seed the existing back-catalog as "seen" the first time *anyone* follows
    // this artist, so we only auto-grab releases that appear from now on.
    const firstFollower = !db.prepare('SELECT 1 FROM followed_artists WHERE artist_id = ? LIMIT 1').get(id);
    db.prepare(`INSERT OR IGNORE INTO followed_artists (user_id, artist_id, artist_name, artist_picture) VALUES (?, ?, ?, ?)`)
      .run(req.user.id, id, a.name, picture);
    if (firstFollower) await seedSeenAlbums(id);
    res.json({ following: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

api.delete('/following/:artistId', (req, res) => {
  const id = parseInt(req.params.artistId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid artist id' });
  db.prepare('DELETE FROM followed_artists WHERE user_id = ? AND artist_id = ?').run(req.user.id, id);
  res.json({ following: false });
});

api.get('/album/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid album id' });
  try {
    const album = await deezerGet(`album/${id}`);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    res.json({
      id: album.id, title: album.title, artist: album.artist?.name, artist_id: album.artist?.id,
      cover: album.cover_big || album.cover_medium, release_date: album.release_date,
      nb_tracks: album.nb_tracks,
      tracks: (album.tracks?.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
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
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
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
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid playlist id' });
  try {
    const pl = await deezerGet(`playlist/${id}`);
    const haveTrack = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
    res.json({
      id: pl.id, title: pl.title, cover: pl.picture_big || pl.picture_medium,
      by: pl.creator?.name || pl.user?.name || 'Deezer', nb_tracks: pl.nb_tracks,
      tracks: (pl.tracks?.data || []).map(t => ({
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
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
  const haveAlbum = db.prepare('SELECT 1 FROM tracks WHERE album_id = ? AND file_path IS NOT NULL LIMIT 1');
  const mapAlbum = a => ({
    id: a.id, title: a.title, artist: a.artist?.name, artist_id: a.artist?.id,
    cover: a.cover_medium || a.cover, nb_tracks: a.nb_tracks, release_date: a.release_date,
    available: !!haveAlbum.get(a.id),
  });
  const mapPlaylist = p => ({
    id: p.id, title: p.title, cover: p.picture_medium || p.picture,
    nb_tracks: p.nb_tracks, by: p.user?.name || p.creator?.name || 'Deezer',
  });
  const mapArtist = a => ({ id: a.id, name: a.name, picture: a.picture_medium });

  try {
    // Each section is best-effort so one failing endpoint doesn't blank the page.
    const [genreR, releases, topAlbums, topPlaylists, topArtists] = await Promise.all([
      deezerGet('genre').catch(() => ({ data: [] })),
      deezerGet('editorial/0/releases?limit=20').catch(() => ({ data: [] })),
      deezerGet('chart/0/albums?limit=20').catch(() => ({ data: [] })),
      deezerGet('chart/0/playlists?limit=20').catch(() => ({ data: [] })),
      deezerGet('chart/0/artists?limit=20').catch(() => ({ data: [] })),
    ]);
    // Give each mood a real cover image from the top matching Deezer playlist
    // (cached). Falls back to no image -> the UI shows a gradient.
    const moods = await Promise.all(MOODS.map(async m => {
      let image = null;
      try {
        const r = await deezerGet(`search/playlist?q=${encodeURIComponent(m.q)}&limit=1`);
        const p = r.data?.[0];
        image = p?.picture_xl || p?.picture_big || p?.picture_medium || p?.picture || null;
      } catch { /* gradient fallback in the UI */ }
      return { slug: m.slug, name: m.name, image };
    }));
    res.json({
      releases: (releases.data || []).map(mapAlbum),
      topAlbums: (topAlbums.data || []).map(mapAlbum),
      topPlaylists: (topPlaylists.data || []).map(mapPlaylist),
      topArtists: (topArtists.data || []).map(mapArtist),
      moods,
      genres: (genreR.data || [])
        .filter(x => x.id !== 0) // "All"
        .map(x => ({ id: x.id, name: x.name, picture: x.picture_medium || x.picture })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Moods don't exist as a Deezer API primitive, so each maps to a search term
// for curated playlists; the top playlist's tracks give the "songs for <mood>"
// and its cover art the mood-card image.
const MOODS = [
  { slug: 'happy', name: 'Happy', q: 'happy hits' },
  { slug: 'chill', name: 'Chill', q: 'chill' },
  { slug: 'sad', name: 'Melancholy', q: 'sad songs' },
  { slug: 'energetic', name: 'Energetic', q: 'energy boost' },
  { slug: 'romantic', name: 'Romantic', q: 'love songs' },
  { slug: 'focus', name: 'Focus', q: 'focus concentration' },
  { slug: 'party', name: 'Party', q: 'party hits' },
  { slug: 'sleep', name: 'Sleep', q: 'sleep calm' },
  { slug: 'workout', name: 'Workout', q: 'workout motivation' },
  { slug: 'study', name: 'Study', q: 'study lofi' },
  { slug: 'feelgood', name: 'Feel good', q: 'feel good' },
  { slug: 'throwback', name: 'Throwback', q: 'throwback hits' },
  { slug: 'summer', name: 'Summer', q: 'summer hits' },
  { slug: 'rainy', name: 'Rainy day', q: 'rainy day' },
  { slug: 'dance', name: 'Dance', q: 'dance hits' },
  { slug: 'rnb', name: 'R&B', q: 'rnb soul' },
  { slug: 'heartbreak', name: 'Heartbreak', q: 'heartbreak' },
  { slug: 'roadtrip', name: 'Road trip', q: 'road trip' },
  { slug: 'jazz', name: 'Jazz', q: 'jazz lounge' },
  { slug: 'motivation', name: 'Motivation', q: 'motivation' },
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
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
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
        id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
        album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
        duration: t.duration, available: !!haveTrack.get(t.id)?.file_path,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

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
// Fill in a playlist row's track count and a representative cover.
function playlistMeta(l) {
  l.count = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(l.id).n;
  l.cover = db.prepare(`
    SELECT t.cover FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
    WHERE pi.playlist_id = ? AND t.cover IS NOT NULL ORDER BY pi.position LIMIT 1
  `).get(l.id)?.cover || null;
  return l;
}

// Resolve a user's relationship to a playlist: 'owner' | 'editor' | 'viewer',
// or { found:false } when the playlist doesn't exist. Viewing is open within the
// server, so a user with no share is still a 'viewer'.
function playlistRole(playlistId, userId) {
  const l = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!l) return { found: false };
  if (l.user_id === userId) return { found: true, list: l, role: 'owner' };
  const s = db.prepare('SELECT can_edit FROM playlist_shares WHERE playlist_id = ? AND user_id = ?')
    .get(playlistId, userId);
  return { found: true, list: l, role: s ? (s.can_edit ? 'editor' : 'viewer') : 'viewer', shared: !!s };
}
const canEditRole = (role) => role === 'owner' || role === 'editor';

api.get('/playlists', (req, res) => {
  const owned = db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at').all(req.user.id)
    .map(l => ({ ...l, is_owner: true, shared: false }));
  // Playlists other users have shared with me.
  const shared = db.prepare(`
    SELECT p.*, ps.can_edit AS can_edit, ou.username AS owner_name
    FROM playlist_shares ps
    JOIN playlists p ON p.id = ps.playlist_id
    JOIN users ou ON ou.id = p.user_id
    WHERE ps.user_id = ? ORDER BY p.created_at
  `).all(req.user.id).map(l => ({ ...l, is_owner: false, shared: true }));
  res.json([...owned, ...shared].map(playlistMeta));
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
api.post('/playlists/import-deezer', importLimit, async (req, res) => {
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
  // Any signed-in user can view a playlist (visibility is open within the
  // server). Owners and shared editors can modify it.
  const { found, list, role } = playlistRole(req.params.id, req.user.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  list.is_owner = role === 'owner';
  list.can_edit = canEditRole(role);
  list.role = role;
  list.owner_name = db.prepare('SELECT username FROM users WHERE id = ?').get(list.user_id)?.username || null;
  // Owners get the share list so they can manage it.
  if (role === 'owner') {
    list.shares = db.prepare(`
      SELECT ps.user_id, u.username, ps.can_edit FROM playlist_shares ps
      JOIN users u ON u.id = ps.user_id WHERE ps.playlist_id = ? ORDER BY u.username COLLATE NOCASE
    `).all(list.id);
  }
  list.tracks = db.prepare(`
    SELECT t.*, pi.position FROM playlist_items pi JOIN tracks t ON t.deezer_id = pi.track_id
    WHERE pi.playlist_id = ? ORDER BY pi.position
  `).all(list.id);
  res.json(list);
});

api.delete('/playlists/:id', (req, res) => {
  // The owner deletes the playlist outright; a recipient "deleting" a playlist
  // shared with them just removes their own share (it leaves their library).
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found) return res.json({ ok: true });
  if (role === 'owner') db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  else db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

api.post('/playlists/:id/tracks', (req, res) => {
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found || !canEditRole(role)) return res.status(found ? 403 : 404).json({ error: found ? 'No edit access' : 'Not found' });
  const trackId = ensureTrack(req.body?.track_id, req.body?.track);
  if (!trackId) return res.status(400).json({ error: 'Unknown track — open it once so its details are known, then add it' });
  const pos = (db.prepare('SELECT MAX(position) AS m FROM playlist_items WHERE playlist_id = ?').get(req.params.id).m ?? -1) + 1;
  db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, position, track_id) VALUES (?, ?, ?)').run(req.params.id, pos, trackId);
  res.json({ ok: true });
});

api.delete('/playlists/:id/tracks/:trackId', (req, res) => {
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found || !canEditRole(role)) return res.status(found ? 403 : 404).json({ error: found ? 'No edit access' : 'Not found' });
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?').run(req.params.id, req.params.trackId);
  res.json({ ok: true });
});

/* ------------------------------------------------ Playlist sharing (collab) */
// Only the owner can manage who a playlist is shared with.
function requireOwner(req, res) {
  const { found, role } = playlistRole(req.params.id, req.user.id);
  if (!found) { res.status(404).json({ error: 'Not found' }); return false; }
  if (role !== 'owner') { res.status(403).json({ error: 'Only the owner can manage sharing' }); return false; }
  return true;
}

api.get('/playlists/:id/shares', (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json(db.prepare(`
    SELECT ps.user_id, u.username, ps.can_edit, ps.created_at FROM playlist_shares ps
    JOIN users u ON u.id = ps.user_id WHERE ps.playlist_id = ? ORDER BY u.username COLLATE NOCASE
  `).all(req.params.id));
});

// Share with a user (or update their permission). Body: { user_id, can_edit }.
api.post('/playlists/:id/shares', (req, res) => {
  if (!requireOwner(req, res)) return;
  const userId = parseInt(req.body?.user_id, 10);
  const canEdit = req.body?.can_edit ? 1 : 0;
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'user_id required' });
  const owner = db.prepare('SELECT user_id FROM playlists WHERE id = ?').get(req.params.id)?.user_id;
  if (userId === owner) return res.status(400).json({ error: "You already own this playlist" });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'User not found' });
  db.prepare(`
    INSERT INTO playlist_shares (playlist_id, user_id, can_edit) VALUES (?, ?, ?)
    ON CONFLICT(playlist_id, user_id) DO UPDATE SET can_edit = excluded.can_edit
  `).run(req.params.id, userId, canEdit);
  res.json({ ok: true, user_id: userId, can_edit: !!canEdit });
});

api.delete('/playlists/:id/shares/:userId', (req, res) => {
  if (!requireOwner(req, res)) return;
  db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ? AND user_id = ?')
    .run(req.params.id, parseInt(req.params.userId, 10));
  res.json({ ok: true });
});

/* --------------------------------------------------- Plays / history / recs */
// Map a Deezer track object to our wire shape, flagging on-disk availability.
const haveTrackStmt = () => db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
function mapTrack(t, have) {
  return {
    id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
    album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
    duration: t.duration, available: !!have.get(t.id)?.file_path,
  };
}

// Record that the user played a track (drives history + recommendations).
api.post('/plays', (req, res) => {
  const id = parseInt(req.body?.track_id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'track_id required' });
  // Only log known tracks, and de-dupe rapid repeats (also prevents a client
  // from spamming this endpoint to grow the plays table without bound).
  if (db.prepare('SELECT 1 FROM tracks WHERE deezer_id = ?').get(id)) {
    const recent = db.prepare(
      `SELECT 1 FROM plays WHERE user_id = ? AND track_id = ? AND played_at > datetime('now','-30 seconds')`
    ).get(req.user.id, id);
    if (!recent) db.prepare('INSERT INTO plays (user_id, track_id) VALUES (?, ?)').run(req.user.id, id);
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

/* --------------------------------------------------- Playback preferences */
// Per-user playback settings (volume, equalizer, repeat mode) live on the
// server so they sync across all of a user's clients. The browser still keeps a
// localStorage copy as an instant/offline cache; this is the source of truth.
const REPEAT_MODES = new Set(['off', 'all', 'one']);

// Coerce an arbitrary client-supplied object into a clean, validated subset.
// Unknown keys are dropped; bad values are simply omitted (not stored).
function sanitizePrefs(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if ('volume' in input) {
    const v = Number(input.volume);
    if (Number.isFinite(v)) out.volume = Math.min(1, Math.max(0, v));
  }
  if ('eqEnabled' in input) out.eqEnabled = !!input.eqEnabled;
  if ('eqGains' in input && Array.isArray(input.eqGains)) {
    const g = input.eqGains.map(Number);
    if (g.every(Number.isFinite)) out.eqGains = g;
  }
  if ('repeat' in input && REPEAT_MODES.has(input.repeat)) out.repeat = input.repeat;
  return out;
}

function readPrefs(userId) {
  const row = db.prepare('SELECT data FROM user_prefs WHERE user_id = ?').get(userId);
  if (!row) return {};
  try { const obj = JSON.parse(row.data); return obj && typeof obj === 'object' ? obj : {}; }
  catch { return {}; }
}

api.get('/preferences', (req, res) => {
  res.json(readPrefs(req.user.id));
});

api.put('/preferences', (req, res) => {
  // Merge the (validated) partial into whatever is already stored so keys the
  // client didn't send are preserved.
  const merged = { ...readPrefs(req.user.id), ...sanitizePrefs(req.body) };
  db.prepare(`
    INSERT INTO user_prefs (user_id, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify(merged));
  res.json(merged);
});

/* ------------------------------------------------------- Listening stats */
// A personal "Wrapped"-style dashboard computed from the user's play history.
// `range` selects the window: 'month' (30d), 'year' (365d) or 'all' (default).
const STATS_WINDOWS = { week: '-7 days', month: '-30 days', year: '-365 days' };
api.get('/stats', (req, res) => {
  // Optionally view another user's stats (?user=:id). Profiles are public to any
  // signed-in user (same as /api/social/users/:id), so no extra gate is needed.
  const requested = parseInt(req.query.user, 10);
  let userId = req.user.id;
  let username = null;
  if (Number.isFinite(requested) && requested !== req.user.id) {
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(requested);
    if (!u) return res.status(404).json({ error: 'User not found' });
    userId = u.id;
    username = u.username;
  }
  const rangeKey = STATS_WINDOWS[req.query.range] ? req.query.range : 'all';
  // A SQL WHERE fragment + bound args for the selected window.
  const since = STATS_WINDOWS[rangeKey];
  const where = since ? `p.user_id = ? AND p.played_at > datetime('now', ?)` : `p.user_id = ?`;
  const args = since ? [userId, since] : [userId];

  const totals = db.prepare(`
    SELECT COUNT(*) AS plays,
           COUNT(DISTINCT p.track_id) AS tracks,
           COUNT(DISTINCT t.artist_id) AS artists,
           COALESCE(SUM(t.duration), 0) AS seconds
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where}
  `).get(...args);

  const topArtists = db.prepare(`
    SELECT t.artist_id, t.artist, COUNT(*) AS plays, MAX(t.cover) AS cover
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where} AND t.artist_id IS NOT NULL
    GROUP BY t.artist_id ORDER BY plays DESC, t.artist LIMIT 12
  `).all(...args);

  const topTracks = db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where}
    GROUP BY p.track_id ORDER BY plays DESC, MAX(p.played_at) DESC LIMIT 15
  `).all(...args);

  const topAlbums = db.prepare(`
    SELECT t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist,
           MAX(t.cover) AS cover, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE ${where} AND t.album_id IS NOT NULL
    GROUP BY t.album_id ORDER BY plays DESC LIMIT 8
  `).all(...args);

  // Per-day play counts for the last 14 days, for a small activity sparkline.
  const daily = db.prepare(`
    SELECT date(p.played_at) AS day, COUNT(*) AS plays
    FROM plays p
    WHERE p.user_id = ? AND p.played_at > datetime('now','-14 days')
    GROUP BY day ORDER BY day
  `).all(userId);

  res.json({ range: rangeKey, username, totals, topArtists, topTracks, topAlbums, daily });
});

/* ----------------------------------------------------- Made-for-you mixes */
// Two flavours of auto-generated, ready-to-play collections:
//  - "smart" playlists computed straight from the user's own library/history
//    (On Repeat, Recently Added, Liked songs) — immediately playable.
//  - "daily" discovery mixes seeded from the user's top artists, pulling
//    Deezer related-artist tracks (downloadable on tap).
api.get('/mixes', async (req, res) => {
  const userId = req.user.id;
  const smart = [];

  const onRepeat = db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.deezer_id = p.track_id
    WHERE p.user_id = ? AND p.played_at > datetime('now','-60 days') AND t.file_path IS NOT NULL
    GROUP BY p.track_id ORDER BY plays DESC, MAX(p.played_at) DESC LIMIT 40
  `).all(userId);
  if (onRepeat.length >= 3) {
    smart.push({ key: 'on-repeat', title: 'On Repeat', subtitle: 'The tracks you keep coming back to',
      cover: onRepeat[0]?.cover || null, tracks: onRepeat });
  }

  const recentlyAdded = db.prepare(`
    SELECT t.*, 1 AS available FROM tracks t
    WHERE t.file_path IS NOT NULL AND t.in_library = 1
    ORDER BY t.added_at DESC LIMIT 40
  `).all();
  if (recentlyAdded.length >= 3) {
    smart.push({ key: 'recently-added', title: 'Recently Added', subtitle: 'Fresh in your library',
      cover: recentlyAdded[0]?.cover || null, tracks: recentlyAdded });
  }

  const liked = db.prepare(`
    SELECT t.*, (t.file_path IS NOT NULL) AS available
    FROM favorites f JOIN tracks t ON t.deezer_id = f.track_id
    WHERE f.user_id = ? ORDER BY f.added_at DESC LIMIT 60
  `).all(userId);
  if (liked.length >= 3) {
    smart.push({ key: 'liked', title: 'Liked Songs Mix', subtitle: 'A shuffle of everything you love',
      cover: liked[0]?.cover || null, tracks: liked });
  }

  // Discovery: up to 3 daily mixes seeded from the user's most-listened artists.
  const daily = [];
  try {
    const have = haveTrackStmt();
    const seeds = db.prepare(`
      SELECT t.artist_id, t.artist, COUNT(*) AS n FROM (
        SELECT track_id AS tid FROM favorites WHERE user_id = @u
        UNION ALL SELECT track_id AS tid FROM plays WHERE user_id = @u
      ) x JOIN tracks t ON t.deezer_id = x.tid
      WHERE t.artist_id IS NOT NULL
      GROUP BY t.artist_id ORDER BY n DESC LIMIT 3
    `).all({ u: userId });

    let n = 1;
    for (const seed of seeds) {
      const [top, relatedList] = await Promise.all([
        deezerGet(`artist/${seed.artist_id}/top?limit=12`).catch(() => ({ data: [] })),
        deezerGet(`artist/${seed.artist_id}/related?limit=4`).catch(() => ({ data: [] })),
      ]);
      const seen = new Set();
      const tracks = [];
      for (const t of (top.data || [])) { if (!seen.has(t.id)) { seen.add(t.id); tracks.push(mapTrack(t, have)); } }
      const relTops = await Promise.all(
        (relatedList.data || []).slice(0, 3).map(a => deezerGet(`artist/${a.id}/top?limit=5`).catch(() => ({ data: [] })))
      );
      for (const rt of relTops) for (const t of (rt.data || [])) {
        if (!seen.has(t.id)) { seen.add(t.id); tracks.push(mapTrack(t, have)); }
      }
      if (tracks.length >= 5) {
        const names = [seed.artist, ...(relatedList.data || []).slice(0, 2).map(a => a.name)];
        daily.push({
          key: `daily-${seed.artist_id}`, title: `Daily Mix ${n++}`,
          subtitle: names.join(', '),
          cover: tracks.find(t => t.cover)?.cover || null,
          tracks,
        });
      }
    }
  } catch { /* discovery is best-effort; smart mixes still return */ }

  res.json({ smart, daily });
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
