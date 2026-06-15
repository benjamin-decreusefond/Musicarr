import { db, config } from './db.js';
import { deezerGet } from './sources.js';
import { queueDownload } from './downloader.js';
import { logger } from './log.js';

const log = logger('releases');

// Which Deezer record types are auto-downloaded for a followed artist. Default
// skips "compilation" (best-of / various-artists re-releases that are mostly
// noise); override with RELEASE_TYPES, e.g. "album" for studio albums only.
const RECORD_TYPES = new Set(
  (process.env.RELEASE_TYPES || 'album,ep,single')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
// Safety cap: never queue more than this many albums for one artist in a single
// run (guards against a Deezer back-catalog appearing all at once). Remaining
// albums are left unseen and picked up on subsequent runs.
const MAX_PER_ARTIST_PER_RUN = 5;

/**
 * Record an artist's current albums as "seen" without queueing them, so that
 * following an artist never triggers a download of their entire back-catalog —
 * only releases that show up *after* this point are auto-grabbed. Called when the
 * first user follows a given artist.
 */
export async function seedSeenAlbums(artistId) {
  try {
    const albums = await deezerGet(`artist/${artistId}/albums?limit=200`);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO seen_artist_albums (artist_id, album_id, queued) VALUES (?, ?, 1)`
    );
    const seed = db.transaction(list => { for (const a of list) ins.run(artistId, a.id); });
    seed(albums.data || []);
    log.info(`seeded ${albums.data?.length || 0} existing album(s) as seen for artist ${artistId}`);
  } catch (e) {
    log.warn(`could not seed albums for artist ${artistId}: ${e.message}`);
  }
}

/**
 * For every followed artist, find Deezer albums we haven't seen yet and queue a
 * download for each (one queue per artist regardless of how many users follow,
 * since the library is shared). Returns the number of albums queued.
 */
export async function checkFollowedArtists() {
  if (!config.slskdEnabled) return 0; // nowhere to download to yet
  // De-duplicate followers: one download per artist, attributed to the earliest
  // follower (downloads need an owning user).
  const artists = db.prepare(`
    SELECT fa.artist_id AS artist_id, fa.artist_name AS artist_name, MIN(fa.user_id) AS owner_id
    FROM followed_artists fa GROUP BY fa.artist_id
  `).all();
  if (!artists.length) return 0;

  const markSeen = db.prepare(
    `INSERT OR IGNORE INTO seen_artist_albums (artist_id, album_id, queued) VALUES (?, ?, 1)`
  );
  let queued = 0;
  for (const a of artists) {
    try {
      const albums = await deezerGet(`artist/${a.artist_id}/albums?limit=100`);
      const seen = new Set(
        db.prepare('SELECT album_id FROM seen_artist_albums WHERE artist_id = ?')
          .all(a.artist_id).map(r => r.album_id)
      );
      const fresh = (albums.data || [])
        .filter(al => !seen.has(al.id))
        .filter(al => RECORD_TYPES.has((al.record_type || 'album').toLowerCase()))
        // Newest first so the per-run cap keeps the most recent releases.
        .sort((x, y) => String(y.release_date || '').localeCompare(String(x.release_date || '')));

      let n = 0;
      for (const al of fresh) {
        if (n >= MAX_PER_ARTIST_PER_RUN) break; // leave the rest unseen for next run
        const label = `${a.artist_name} – ${al.title}`;
        try {
          queueDownload(a.owner_id, 'album', al.id, label, al.cover_medium);
          markSeen.run(a.artist_id, al.id);
          n++; queued++;
          log.info(`new release: queued "${label}" (album ${al.id})`);
        } catch (e) {
          log.warn(`failed to queue album ${al.id} for ${a.artist_name}: ${e.message}`);
        }
      }
    } catch (e) {
      log.warn(`release check failed for artist ${a.artist_id} (${a.artist_name}): ${e.message}`);
    }
  }
  if (queued) log.info(`release watcher queued ${queued} new album(s) across ${artists.length} artist(s)`);
  return queued;
}

export function startReleaseWatcher() {
  if (!config.releaseWatchEnabled) {
    log.info('release watcher disabled (RELEASE_WATCH_ENABLED=false)');
    return;
  }
  log.info(`release watcher started, every ${config.releaseCheckIntervalMs}ms`);
  // First pass shortly after boot, then on the configured interval.
  setTimeout(() => checkFollowedArtists().catch(e => log.error('release check failed', e)), 90_000);
  setInterval(() => checkFollowedArtists().catch(e => log.error('release check failed', e)),
    config.releaseCheckIntervalMs).unref?.();
}
