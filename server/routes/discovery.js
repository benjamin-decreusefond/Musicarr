import { db } from '../db.js';
import { deezerGet } from '../sources.js';
export function registerDiscovery(api) {
// Map a Deezer track object to our wire shape, flagging on-disk availability.
const haveTrackStmt = () => db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
function mapTrack(t, have) {
  return {
    id: t.id, title: t.title, artist: t.artist?.name, artist_id: t.artist?.id, contributors: (t.contributors || []).map(c => ({ id: c.id, name: c.name })),
    album: t.album?.title, album_id: t.album?.id, cover: t.album?.cover_medium,
    duration: t.duration, available: !!have.get(t.id)?.file_path,
  };
}


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

}
