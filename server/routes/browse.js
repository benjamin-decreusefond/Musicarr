import { db, upsertArtist, getMoodImages, setMoodImage } from '../db.js';
import { deezerGet } from '../sources.js';
import { seedSeenAlbums } from '../releases.js';
import { rateLimit } from '../ratelimit.js';
export function registerBrowse(api) {
  const searchLimit = rateLimit({ windowMs: 60_000, max: 60 });
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
    // Give each mood a real cover image from the top matching Deezer playlist.
    // Cached persistently (mood_images): only moods we haven't seen hit Deezer,
    // so a warm Explore makes zero cover requests. Missing -> UI gradient.
    const cachedMoods = getMoodImages();
    const moods = await Promise.all(MOODS.map(async m => {
      let image = cachedMoods[m.slug] || null;
      if (!image) {
        try {
          const r = await deezerGet(`search/playlist?q=${encodeURIComponent(m.q)}&limit=1`);
          const p = r.data?.[0];
          image = p?.picture_xl || p?.picture_big || p?.picture_medium || p?.picture || null;
          setMoodImage(m.slug, image);
        } catch { /* gradient fallback in the UI */ }
      }
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

}
