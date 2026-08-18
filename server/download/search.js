// Search stage: queue a download, find candidates on Soulseek (track files or
// whole album folders), and enqueue the best one with slskd. Also owns
// cancel/manual-retry since both act on the queue.
import fs from 'node:fs';
import path from 'node:path';
import { db, config, upsertTrack, trackRowFromDeezer } from '../db.js';
import { deezerGet, slskdSearch, slskdEnqueue, slskdTransfers, slskdCancel, scoreSlskdFiles, scoreSlskdFolders,
  slskdReady, isTransientSlskdError } from '../sources.js';
import { logger } from '../log.js';
import { walkAudio, safeName, normTitle, searchVariants, slskdFilesOf, pruneEmptyDirs } from './util.js';
import { setStatus, publishDownload } from './status.js';
import { blockedPeerSet } from './peers.js';
import { upgradeProfile } from '../quality.js';
import { isExcluded } from './retry.js';
import { pendingImports, progressTrack } from './import.js';

const log = logger('download');

/** Suffix for a "nothing found" message when the preferred-format setting
 *  restricted the candidates — otherwise an empty result is puzzling. */
function formatNote() {
  const f = config.downloadFormat;
  return f === 'any' ? '' : ` (only ${f.toUpperCase()} files are accepted — see Settings)`;
}

/** True when a single track is already present on disk (avoids re-downloading
 *  the same content). Albums are checked track-by-track in albumViaSlskd. */
function trackOnDisk(deezerId) {
  const f = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(deezerId)?.file_path;
  return !!(f && fs.existsSync(f));
}

/**
 * Queue a download. `kind` is 'album' or 'track'. Returns the download row id.
 * The actual work happens asynchronously in startSearch().
 */
export function queueDownload(userId, kind, deezerId, label, cover, { toLibrary = true, upgrade = false } = {}) {
  const toLib = toLibrary ? 1 : 0;
  // Dedupe: if a single track is already on disk, record it as done instead of
  // searching Soulseek for a copy we already have. An upgrade is the one case
  // where having the file is exactly the point — it is looking for a better one.
  if (kind === 'track' && !upgrade && trackOnDisk(deezerId)) {
    const done = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, cover, engine, status, detail, progress, to_library) VALUES (?, ?, ?, ?, ?, 'soulseek', 'done', 'Already in library', 1, ?)`)
      .run(userId, kind, deezerId, label, cover || null, toLib);
    log.info(`#${done.lastInsertRowid} ${kind} ${deezerId} already on disk — skipped download`);
    publishDownload(done.lastInsertRowid);
    return done.lastInsertRowid;
  }
  const existing = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, cover, engine, to_library, is_upgrade) VALUES (?, ?, ?, ?, ?, 'soulseek', ?, ?)`)
    .run(userId, kind, deezerId, label, cover || null, toLib, upgrade ? 1 : 0);
  const id = existing.lastInsertRowid;
  log.info(`#${id} queued ${kind} ${deezerId}${upgrade ? ' (upgrade)' : ''} by user ${userId}: ${label}`);
  publishDownload(id);
  runSearch(id);
  return id;
}

/** Cancel any in-flight slskd transfers for a download (best-effort), drop its
 *  in-memory import/progress state, and remove files it already pulled into
 *  the slskd downloads dir — the user no longer wants them. Called when a
 *  download is dismissed or cancelled. Files of a 'done' download are imported
 *  (hardlinked), so those — and anything a track references as its source —
 *  are never touched. */
export async function cancelDownloadTransfers(dl) {
  pendingImports.delete(dl.id);
  progressTrack.delete(dl.id);
  if (dl.slskd_user) {
    try {
      const transfers = await slskdTransfers(dl.slskd_user);
      const mine = new Set(slskdFilesOf(dl));
      for (const t of transfers) {
        if (mine.has(t.filename)) await slskdCancel(dl.slskd_user, t.id);
      }
    } catch { /* best-effort */ }
  }
  if (dl.status === 'done') return;
  const remote = slskdFilesOf(dl);
  const wantBases = new Set(remote.map(f => f.split(/[\\/]/).pop()));
  if (!wantBases.size) return;
  // Only look inside the download's own remote folder(s) — no full-tree walk.
  const remoteDirs = [...new Set(remote.map(f => f.split(/[\\/]/).slice(-2, -1)[0]).filter(Boolean))];
  const isSource = db.prepare('SELECT 1 FROM tracks WHERE source_path = ?');
  for (const d of remoteDirs) {
    const dir = path.join(config.slskdDownloadDir, safeName(d));
    if (!fs.existsSync(dir)) continue;
    for (const f of walkAudio(dir)) {
      if (!wantBases.has(path.basename(f)) || isSource.get(f)) continue;
      try {
        fs.unlinkSync(f);
        pruneEmptyDirs(f);
        log.info(`#${dl.id} removed leftover download file: ${path.basename(f)}`);
      } catch { /* best-effort */ }
    }
  }
}

/** Manually re-queue a failed download for another search, clearing prior retry
 *  bookkeeping so it can try peers/candidates again from scratch. */
export function retryDownload(dl) {
  log.info(`#${dl.id} manual retry requested`);
  setStatus(dl.id, 'searching', 'Retrying…', {
    slskd_user: null, slskd_file: null, progress: 0, attempts: 0, failed_candidates: null,
  });
  runSearch(dl.id);
}

/* ---------------------------------------------------- Search concurrency gate */
// Limit how many downloads actively search/enqueue at once. Excess work waits
// in a FIFO queue rather than hammering slskd all at once (e.g. a 50-track
// playlist import).
let activeSearches = 0;
const searchQueue = [];
export function runSearch(downloadId) {
  searchQueue.push(downloadId);
  pumpSearches();
}
function pumpSearches() {
  while (activeSearches < config.maxConcurrentDownloads && searchQueue.length) {
    const id = searchQueue.shift();
    activeSearches++;
    startSearch(id)
      .catch(e => { log.error(`#${id} startSearch failed`, e); setStatus(id, 'error', String(e.message || e)); })
      .finally(() => { activeSearches--; pumpSearches(); });
  }
}

async function startSearch(downloadId) {
  const dl = db.prepare('SELECT * FROM downloads WHERE id = ?').get(downloadId);
  if (!dl) return;
  if (!config.slskdEnabled) {
    return setStatus(downloadId, 'error', 'Soulseek (slskd) is not configured — set it under Settings');
  }
  if (dl.kind === 'album') return albumViaSlskd(dl);
  return trackViaSlskd(dl);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait until slskd is connected and logged in to Soulseek (it briefly isn't
 *  right after a VPN reconnect, which makes enqueues fail with a 500). */
async function ensureSlskdReady(dlId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  while (Date.now() < deadline) {
    if (await slskdReady()) { if (waited) log.info(`#${dlId} slskd reconnected to Soulseek`); return true; }
    waited = true;
    log.info(`#${dlId} waiting for slskd to (re)connect to Soulseek…`);
    await sleep(3000);
  }
  return false;
}

/** Enqueue, retrying the SAME candidate through transient slskd states (e.g.
 *  a reconnect in progress). Throws only on a genuine rejection. */
async function enqueueWithRetry(dlId, username, files) {
  for (let attempt = 1; ; attempt++) {
    try { return await slskdEnqueue(username, files); }
    catch (e) {
      if (isTransientSlskdError(e) && attempt <= 3) {
        log.info(`#${dlId} enqueue from ${username} hit transient slskd state (${e.message}); waiting to retry`);
        await ensureSlskdReady(dlId, 15000);
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

/* ------------------------------------------------------------ Track flow */
async function trackViaSlskd(dl) {
  const tr = await deezerGet(`track/${dl.deezer_id}`);
  const row = trackRowFromDeezer(tr);
  upsertTrack(row);

  // Already on disk? Done instantly.
  const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(dl.deezer_id);
  if (have?.file_path && fs.existsSync(have.file_path)) {
    return setStatus(dl.id, 'done', 'Already in library', { progress: 1 });
  }

  setStatus(dl.id, 'searching', 'Searching Soulseek');
  // Soulseek requires EVERY search term to appear in the file path, and peers
  // often file tracks in folders that don't name the artist (e.g. soundtracks,
  // "Skyfall (Single)"). So "artist title" can return nothing while "title"
  // alone finds it. Try from specific to broad, stopping at the first query
  // that yields a candidate; scoreSlskdFiles filters wrong songs out via the
  // artist name and the Deezer duration.
  const queries = searchVariants(row.artist, row.title);

  // Distinguish "slskd was unavailable" from "genuinely no candidates": only the
  // latter should end as not_found (terminal). Transient slskd trouble ends as a
  // retriable error so the sweep re-attempts it once slskd recovers.
  let slskdDown = false;
  for (const q of queries) {
    log.info(`#${dl.id} slskd search: "${q}"`);
    let files = [];
    try { files = await slskdSearch(q); }
    catch (e) { log.warn(`#${dl.id} slskd search failed: ${e.message}`); if (isTransientSlskdError(e)) slskdDown = true; continue; }
    const blocked = blockedPeerSet();
    // An upgrade only ever wants the target format, so anything that comes
    // back is by definition better than what is on disk and the import can
    // replace it without a second opinion.
    const ranked = scoreSlskdFiles(files, row.artist, row.title, tr.duration || null,
      dl.is_upgrade ? upgradeProfile() : config.qualityProfile)
      .filter(f => !isExcluded(dl, f.username, f.filename) && !blocked.has(f.username));
    log.info(`#${dl.id} "${q}": ${files.length} audio file(s), ${ranked.length} viable`);

    if (ranked.length && !await ensureSlskdReady(dl.id)) slskdDown = true;
    // Try candidates in order until one peer accepts the request.
    for (const file of ranked.slice(0, 5)) {
      try {
        await enqueueWithRetry(dl.id, file.username, file);
        const base = file.filename.split(/[\\/]/).pop();
        log.info(`#${dl.id} slskd queued "${base}" from ${file.username}`);
        setStatus(dl.id, 'downloading', `Soulseek: ${base}`, {
          slskd_user: file.username, slskd_file: file.filename,
          release_title: base, progress: 0,
        });
        pendingImports.set(dl.id, {
          wantedTracks: [row], kind: 'track', requiredId: row.deezer_id,
          slskdUser: file.username, slskdFiles: [file.filename],
        });
        return;
      } catch (e) {
        log.warn(`#${dl.id} slskd peer ${file.username} rejected the file: ${e.message}`);
        if (isTransientSlskdError(e)) slskdDown = true;
      }
    }
  }
  if (slskdDown) {
    return setStatus(dl.id, 'error', 'slskd was unreachable or offline during search — will retry automatically');
  }
  setStatus(dl.id, 'not_found', dl.attempts > 0
    ? `No more Soulseek candidates after ${dl.attempts} failed attempt(s)${formatNote()}`
    : `No matching file found on Soulseek${formatNote()}`);
}

/* ------------------------------------------------------------ Album flow */
async function albumViaSlskd(dl) {
  const album = await deezerGet(`album/${dl.deezer_id}`);
  const artist = album.artist?.name || '';
  const title = album.title || '';
  const wantedTracks = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
  wantedTracks.forEach(upsertTrack);
  if (!wantedTracks.length) return setStatus(dl.id, 'error', 'Album has no tracks on Deezer');

  // Everything already on disk? Done instantly.
  const haveFile = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?');
  const missing = wantedTracks.filter(w => {
    const f = haveFile.get(w.deezer_id)?.file_path;
    return !(f && fs.existsSync(f));
  });
  if (!missing.length) return setStatus(dl.id, 'done', 'Already in library', { progress: 1 });

  // Don't re-download tracks we already have on disk (e.g. a song previously
  // grabbed as a single): skip folder files whose name matches an on-disk track.
  const haveTitles = wantedTracks
    .filter(w => !missing.includes(w))
    .map(w => normTitle(w.title))
    .filter(t => t.length >= 4); // short titles are too ambiguous to match safely
  const alreadyOnDisk = (file) => {
    const base = normTitle((file.filename || '').split(/[\\/]/).pop());
    return haveTitles.some(h => base.includes(h));
  };

  setStatus(dl.id, 'searching', 'Searching Soulseek');
  const queries = searchVariants(artist, title);
  let slskdDown = false;
  for (const q of queries) {
    log.info(`#${dl.id} slskd album search: "${q}"`);
    let files = [];
    try { files = await slskdSearch(q); }
    catch (e) { log.warn(`#${dl.id} slskd search failed: ${e.message}`); if (isTransientSlskdError(e)) slskdDown = true; continue; }

    // Rank per-peer folders by how much of the *missing* tracklist they cover.
    const blocked = blockedPeerSet();
    const folders = scoreSlskdFolders(files, missing.map(w => w.title))
      .filter(f => !isExcluded(dl, f.username, f.files[0]?.filename) && !blocked.has(f.username));
    log.info(`#${dl.id} "${q}": ${files.length} file(s) in ${folders.length} viable folder(s)`);

    if (folders.length && !await ensureSlskdReady(dl.id)) slskdDown = true;
    for (const folder of folders.slice(0, 5)) {
      // Grab only the files we still need from the folder.
      const needed = folder.files.filter(f => !alreadyOnDisk(f));
      if (!needed.length) continue; // folder only holds tracks we already have
      try {
        await enqueueWithRetry(dl.id, folder.username, needed);
        const dirBase = folder.directory.split(/[\\/]/).pop() || folder.directory;
        log.info(`#${dl.id} slskd queued folder "${dirBase}" (${needed.length} files, covers ${folder.matched}/${missing.length} missing) from ${folder.username}`);
        setStatus(dl.id, 'downloading', `Soulseek: ${dirBase} (${needed.length} files)`, {
          slskd_user: folder.username,
          slskd_file: JSON.stringify(needed.map(f => f.filename)),
          release_title: dirBase, progress: 0,
        });
        pendingImports.set(dl.id, {
          wantedTracks, kind: 'album', requiredId: null,
          slskdUser: folder.username, slskdFiles: needed.map(f => f.filename),
        });
        return;
      } catch (e) {
        log.warn(`#${dl.id} slskd peer ${folder.username} rejected the folder: ${e.message}`);
        if (isTransientSlskdError(e)) slskdDown = true;
      }
    }
  }
  if (slskdDown) {
    return setStatus(dl.id, 'error', 'slskd was unreachable or offline during search — will retry automatically');
  }
  setStatus(dl.id, 'not_found', dl.attempts > 0
    ? `No more Soulseek album folders after ${dl.attempts} failed attempt(s)${formatNote()}`
    : `No album folder found on Soulseek${formatNote()}`);
}
