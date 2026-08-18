// MusicBrainz enrichment.
//
// Deezer is Musicarr's catalog and stays that way: `tracks.deezer_id` is the
// primary key every playlist, favorite and download row points at, so a second
// catalog would be a schema-wide change rather than a feature. What MusicBrainz
// adds here is the identity layer Deezer doesn't have — stable MBIDs for the
// recording, release and artist, plus the original release date.
//
// That matters outside Musicarr. MBIDs are what Picard, Jellyfin, Plex and
// Beets key on: a library tagged with them is one those tools can recognise
// without guessing, which is the whole point of writing tags at all (see
// download/tags.js). The ISRC Deezer already gives us is the exact join key —
// it identifies one specific recording, so the lookup is a lookup and not a
// fuzzy match.
//
// MusicBrainz is a free service run on donations, and it enforces its terms:
// one request per second per client, and a User-Agent that identifies the
// application. Both are honoured below — the rate limit by construction, not by
// convention, so no call site can accidentally bypass it.
import { db, config } from './db.js';
import { createCache } from './cache.js';
import { logger } from './log.js';
import { inc } from './metrics.js';

const log = logger('musicbrainz');

const MB = (process.env.MUSICBRAINZ_URL || 'https://musicbrainz.org').replace(/\/$/, '');
// Required by MusicBrainz: an anonymous or generic User-Agent gets blocked.
const UA = 'Musicarr/1.0 (https://github.com/benjamin-decreusefond/musicarr)';
const TIMEOUT_MS = parseInt(process.env.MUSICBRAINZ_TIMEOUT_MS || '15000', 10);
// Their published limit for anonymous clients.
const MIN_INTERVAL_MS = parseInt(process.env.MUSICBRAINZ_INTERVAL_MS || '1000', 10);

// Answers are stable (an ISRC's recording doesn't change) and an album import
// asks about the same release twenty times over, so a day of caching removes
// most of the traffic.
const mbCache = createCache({ ttlMs: 24 * 60 * 60 * 1000, max: 5000 });

/* ------------------------------------------------------------ rate limiting */
// Every request joins a single chain, each link waiting out the remainder of
// the interval since the previous one. Serialising rather than merely spacing
// also means a burst of twenty album tracks can't open twenty sockets at once.
let chain = Promise.resolve();
let lastAt = 0;

function schedule(fn) {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  // The chain must survive a failed request, or one error stops every later
  // lookup for the lifetime of the process.
  chain = run.catch(() => {});
  return run;
}

/** GET a MusicBrainz web-service path, rate limited and cached. */
export async function mbGet(pathAndQuery) {
  const url = `${MB}/ws/2/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}fmt=json`;
  return mbCache.wrap(url, () => schedule(async () => {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(e => { inc('musicarr_external_requests_total', { service: 'musicbrainz', outcome: 'error' }); throw e; });
    inc('musicarr_external_requests_total', { service: 'musicbrainz', outcome: r.ok ? 'ok' : 'error' });
    // 404 is a legitimate answer here ("no recording carries that ISRC"), not a
    // failure worth retrying or logging.
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`MusicBrainz ${r.status}`);
    return r.json();
  }));
}

/* ------------------------------------------------------------- extraction */
// A recording carries several releases (the single, the album, a compilation,
// every regional pressing). The earliest dated one is the closest thing to "the
// original", which is what a release-date tag should say.
function pickRelease(releases = []) {
  const dated = releases.filter(r => r?.date);
  if (!dated.length) return releases[0] || null;
  return dated.reduce((best, r) => (r.date < best.date ? r : best));
}

/** Reduce a MusicBrainz recording to the four fields worth storing. */
export function fieldsFromRecording(rec) {
  if (!rec?.id) return null;
  const release = pickRelease(rec.releases);
  return {
    mb_recording_id: rec.id,
    mb_release_id: release?.id || null,
    mb_artist_id: rec['artist-credit']?.[0]?.artist?.id || null,
    // Year alone is a valid date tag and is what most pressings carry.
    release_date: release?.date || rec['first-release-date'] || null,
  };
}

/** The recording that carries this ISRC, or null. Exact by construction. */
export async function byIsrc(isrc) {
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(String(isrc || ''))) return null;
  const body = await mbGet(`isrc/${encodeURIComponent(String(isrc).toUpperCase())}?inc=artist-credits+releases`);
  return fieldsFromRecording(body?.recordings?.[0]) || null;
}

/** Fall back to a search when there is no ISRC. Deliberately strict: a wrong
 *  MBID is worse than none, because it is the identifier other tools then trust.
 *  A candidate must score highly *and* agree on length within a few seconds. */
export async function bySearch({ artist, title, duration }) {
  if (!artist || !title) return null;
  const escape = (s) => String(s).replace(/["\\]/g, '\\$&');
  const query = `recording:"${escape(title)}" AND artist:"${escape(artist)}"`;
  const body = await mbGet(`recording?query=${encodeURIComponent(query)}&limit=5&inc=releases`);
  for (const rec of body?.recordings || []) {
    if ((rec.score ?? 0) < 90) continue;
    if (duration && rec.length && Math.abs(rec.length / 1000 - duration) > 5) continue;
    return fieldsFromRecording(rec);
  }
  return null;
}

/** Look a track up (ISRC first, search second) and persist what comes back.
 *  Returns the stored fields, or null when nothing matched.
 *
 *  Never throws: enrichment is a bonus on top of an import that has already
 *  succeeded, and MusicBrainz being slow or down must not cost anyone a file. */
export async function enrichTrack(track) {
  if (!config.musicbrainzEnabled) return null;
  try {
    const found = (await byIsrc(track.isrc))
      || (await bySearch({ artist: track.artist, title: track.title, duration: track.duration }));
    if (!found) {
      log.debug(`no MusicBrainz match for "${track.artist} - ${track.title}"`);
      return null;
    }
    db.prepare(`UPDATE tracks SET mb_recording_id = ?, mb_release_id = ?, mb_artist_id = ?,
                  release_date = COALESCE(?, release_date)
                WHERE deezer_id = ?`)
      .run(found.mb_recording_id, found.mb_release_id, found.mb_artist_id, found.release_date, track.deezer_id);
    log.debug(`matched "${track.artist} - ${track.title}" to recording ${found.mb_recording_id}`);
    return found;
  } catch (e) {
    log.warn(`MusicBrainz lookup failed for "${track.artist} - ${track.title}": ${e.message}`);
    return null;
  }
}

/** Test seam: drop the cache and the rate-limit chain between cases. */
export function resetMusicbrainz() {
  mbCache.clear();
  chain = Promise.resolve();
  lastAt = 0;
}
