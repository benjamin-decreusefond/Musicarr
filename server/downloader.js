import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, config, upsertTrack, trackRowFromDeezer } from './db.js';
import { deezerGet, slskdSearch, slskdEnqueue, slskdTransfers, slskdCancel, scoreSlskdFiles, scoreSlskdFolders,
  slskdReady, isTransientSlskdError } from './sources.js';
import { logger } from './log.js';

const log = logger('download');

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma']);

function setStatus(id, status, detail, extra = {}) {
  const fields = { status, detail: detail ?? null, ...extra };
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE downloads SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ id, ...fields });
  if (status === 'error' || status === 'not_found') log.warn(`#${id} -> ${status}`, detail || '');
  else log.info(`#${id} -> ${status}`, detail || '');
}

/** The slskd_file column stores one filename (track) or a JSON array (album). */
function slskdFilesOf(dl) {
  const raw = dl.slskd_file;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch { return [raw]; }
}

/**
 * Queue a download. `kind` is 'album' or 'track'. Returns the download row id.
 * The actual work happens asynchronously in startSearch().
 */
/** True when a single track is already present on disk (avoids re-downloading
 *  the same content). Albums are checked track-by-track in albumViaSlskd. */
function trackOnDisk(deezerId) {
  const f = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(deezerId)?.file_path;
  return !!(f && fs.existsSync(f));
}

export function queueDownload(userId, kind, deezerId, label, cover) {
  // Dedupe: if a single track is already on disk, record it as done instead of
  // searching Soulseek for a copy we already have.
  if (kind === 'track' && trackOnDisk(deezerId)) {
    const done = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, cover, engine, status, detail, progress) VALUES (?, ?, ?, ?, ?, 'soulseek', 'done', 'Already in library', 1)`)
      .run(userId, kind, deezerId, label, cover || null);
    log.info(`#${done.lastInsertRowid} ${kind} ${deezerId} already on disk — skipped download`);
    return done.lastInsertRowid;
  }
  const existing = db.prepare(`INSERT INTO downloads (user_id, kind, deezer_id, label, cover, engine) VALUES (?, ?, ?, ?, ?, 'soulseek')`)
    .run(userId, kind, deezerId, label, cover || null);
  const id = existing.lastInsertRowid;
  log.info(`#${id} queued ${kind} ${deezerId} by user ${userId}: ${label}`);
  runSearch(id);
  return id;
}

/** Cancel any in-flight slskd transfers for a download (best-effort) and drop
 *  its in-memory import/progress state, so slskd stops pulling files the user
 *  no longer wants. Called when a download is dismissed or cancelled. */
export async function cancelDownloadTransfers(dl) {
  pendingImports.delete(dl.id);
  progressTrack.delete(dl.id);
  if (!dl.slskd_user) return;
  try {
    const transfers = await slskdTransfers(dl.slskd_user);
    const mine = new Set(slskdFilesOf(dl));
    for (const t of transfers) {
      if (mine.has(t.filename)) await slskdCancel(dl.slskd_user, t.id);
    }
  } catch { /* best-effort */ }
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
function runSearch(downloadId) {
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

/* --------------------------------------------------------------- Retries */
// A candidate (peer + file/folder) gets PER_CANDIDATE_MAX transfer attempts
// before being excluded; the download gives up entirely after MAX_ATTEMPTS.
const PER_CANDIDATE_MAX = 2;
const MAX_ATTEMPTS = 6;

const candidateKey = (user, firstFile) => `${user}|${firstFile || ''}`;
function failedCandidatesOf(dl) {
  try { const v = JSON.parse(dl.failed_candidates || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}
function isExcluded(dl, user, firstFile) {
  return (failedCandidatesOf(dl)[candidateKey(user, firstFile)] || 0) >= PER_CANDIDATE_MAX;
}

/** A transfer failed (terminal error or stalled): record the candidate,
 *  cancel leftovers, and either re-search with that candidate excluded or
 *  give up after MAX_ATTEMPTS. */
async function handleTransferFailure(dl, reason) {
  pendingImports.delete(dl.id);
  progressTrack.delete(dl.id);

  // Best-effort: cancel whatever is still queued at the peer so slskd stops
  // pulling a candidate we've given up on.
  try {
    const transfers = await slskdTransfers(dl.slskd_user);
    const mine = new Set(slskdFilesOf(dl));
    for (const t of transfers) {
      if (mine.has(t.filename) && !TERMINAL.test(t.state || '')) await slskdCancel(dl.slskd_user, t.id);
    }
  } catch { /* ignore */ }

  const fails = failedCandidatesOf(dl);
  const key = candidateKey(dl.slskd_user, slskdFilesOf(dl)[0]);
  fails[key] = (fails[key] || 0) + 1;
  const attempts = (dl.attempts || 0) + 1;

  if (attempts >= MAX_ATTEMPTS) {
    return setStatus(dl.id, 'error', `Soulseek transfer failed (${reason}) — gave up after ${attempts} attempts`, {
      attempts, failed_candidates: JSON.stringify(fails),
    });
  }
  log.info(`#${dl.id} transfer from ${dl.slskd_user} failed (${reason}); retrying — attempt ${attempts + 1}/${MAX_ATTEMPTS}, candidate strike ${fails[key]}/${PER_CANDIDATE_MAX}`);
  setStatus(dl.id, 'searching', `Transfer failed (${reason}) — retrying (attempt ${attempts + 1})`, {
    attempts, failed_candidates: JSON.stringify(fails),
    slskd_user: null, slskd_file: null, progress: 0,
  });
  runSearch(dl.id);
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
    const ranked = scoreSlskdFiles(files, row.artist, row.title, tr.duration || null)
      .filter(f => !isExcluded(dl, f.username, f.filename));
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
    ? `No more Soulseek candidates after ${dl.attempts} failed attempt(s)`
    : 'No matching file found on Soulseek');
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
    const folders = scoreSlskdFolders(files, missing.map(w => w.title))
      .filter(f => !isExcluded(dl, f.username, f.files[0]?.filename));
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
    ? `No more Soulseek album folders after ${dl.attempts} failed attempt(s)`
    : 'No album folder found on Soulseek');
}

// downloadId -> import plan, kept in memory while transfers are active.
const pendingImports = new Map();
// downloadId -> { pct, at } — last observed progress, for the stall guard.
const progressTrack = new Map();

/* ------------------------------------------------------------ Poll loop */
export function startPoller() {
  log.info(`poll loop started, every ${config.pollIntervalMs}ms (unimported sweep every ${config.sweepIntervalMs}ms)`);
  setInterval(() => tick().catch(e => log.error('poll tick failed', e)), config.pollIntervalMs);
  setTimeout(() => sweepUnimported().catch(e => log.error('sweep failed', e)), Math.min(15000, config.sweepIntervalMs));
  setInterval(() => sweepUnimported().catch(e => log.error('sweep failed', e)), config.sweepIntervalMs);
  // Auto-cleanup of stale tracks: shortly after boot, then daily.
  setTimeout(() => cleanupStaleTracks().catch(e => log.error('cleanup failed', e)), 60000);
  setInterval(() => cleanupStaleTracks().catch(e => log.error('cleanup failed', e)), 24 * 60 * 60 * 1000);
}

/** Remove downloaded tracks that haven't been played within the configured
 *  window. Favorited tracks and tracks in any playlist are always kept. Tracks
 *  never played are aged from when they were added. Returns the count removed. */
export function cleanupStaleTracks() {
  if (!config.autoCleanupEnabled || config.cleanupAfterDays <= 0) return Promise.resolve(0);
  const days = config.cleanupAfterDays;
  const stale = db.prepare(`
    SELECT t.deezer_id, t.artist, t.title FROM tracks t
    WHERE t.file_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.deezer_id)
      AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.track_id = t.deezer_id)
      AND COALESCE((SELECT MAX(p.played_at) FROM plays p WHERE p.track_id = t.deezer_id), t.added_at)
            < datetime('now', ?)
  `).all(`-${days} days`);
  if (!stale.length) return Promise.resolve(0);
  log.info(`auto-cleanup: removing ${stale.length} track(s) not played in ${days} day(s)`);
  for (const t of stale) {
    try { deleteTrackFile(t.deezer_id); } catch (e) { log.warn(`auto-cleanup: ${t.artist} - ${t.title}: ${e.message}`); }
  }
  return Promise.resolve(stale.length);
}

const TERMINAL = /Completed/i;
const SUCCEEDED = /Succeeded/i;

async function tick() {
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND slskd_user IS NOT NULL`).all();
  for (const dl of active) {
    const wantedFiles = slskdFilesOf(dl);
    if (!wantedFiles.length) continue;
    let transfers;
    try { transfers = await slskdTransfers(dl.slskd_user); }
    catch (e) { log.warn(`#${dl.id} could not poll slskd: ${e.message}`); continue; }
    const byName = new Map(transfers.map(t => [t.filename, t]));
    const mine = wantedFiles.map(f => byName.get(f)).filter(Boolean);
    if (!mine.length) continue; // not visible yet

    const done = mine.filter(t => TERMINAL.test(t.state || ''));
    const ok = done.filter(t => SUCCEEDED.test(t.state || ''));
    if (done.length < wantedFiles.length) {
      // Aggregate progress across the transfer set.
      const pct = mine.reduce((sum, t) => {
        const p = t.percentComplete != null ? t.percentComplete / 100
          : (t.size ? (t.bytesTransferred || 0) / t.size : 0);
        return sum + Math.min(1, p);
      }, 0) / wantedFiles.length;
      if (Math.abs(pct - dl.progress) > 0.01) setStatus(dl.id, 'downloading', dl.detail, { progress: pct });
      // Stall guard: a peer can leave us queued or frozen forever — after
      // slskdStallMs with no progress, fail over to the next candidate.
      const prev = progressTrack.get(dl.id);
      if (!prev || pct > prev.pct + 0.001) {
        progressTrack.set(dl.id, { pct, at: Date.now() });
      } else if (Date.now() - prev.at > config.slskdStallMs) {
        await handleTransferFailure(dl, `stalled at ${Math.round(pct * 100)}% for ${Math.round(config.slskdStallMs / 60000)}min`);
      }
      continue;
    }
    if (!ok.length) {
      await handleTransferFailure(dl, done[0]?.state || 'unknown state');
      continue;
    }
    // All transfers terminal and at least one succeeded -> import.
    setStatus(dl.id, 'importing', 'Importing files', { progress: 1 });
    try {
      const n = await importDownload(dl);
      setStatus(dl.id, 'done', n > 1 ? `Imported ${n} tracks to your library` : 'Added to your library', { progress: 1 });
    } catch (e) {
      // A failed verification (wrong file) should try the next peer, not just error out.
      if (e?.failover) { await handleTransferFailure(dl, String(e.message || e)); continue; }
      setStatus(dl.id, 'error', String(e.message || e));
    }
    pendingImports.delete(dl.id);
    progressTrack.delete(dl.id);
  }
}

/* ------------------------------------------------------------ Sweep */
// Retry downloads whose files finished but never made it into the library
// (crash mid-import, slskd volume briefly unmounted, ...).
const sweepAttempts = new Map(); // dl.id -> last attempt ms
export async function sweepUnimported() {
  const candidates = db.prepare(`
    SELECT * FROM downloads
    WHERE status IN ('error', 'importing') AND slskd_user IS NOT NULL
      AND updated_at > datetime('now', '-7 days')
  `).all();
  for (const dl of candidates) {
    const last = sweepAttempts.get(dl.id) || 0;
    if (Date.now() - last < 60 * 60 * 1000) continue; // at most hourly per download
    sweepAttempts.set(dl.id, Date.now());
    try {
      if (!pendingImports.has(dl.id)) await rebuildPlan(dl);
      const plan = pendingImports.get(dl.id);
      const missing = (plan?.wantedTracks || []).filter(w => {
        const t = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(w.deezer_id);
        return !(t?.file_path && fs.existsSync(t.file_path));
      });
      if (!missing.length) { pendingImports.delete(dl.id); continue; }
      log.info(`sweep: download #${dl.id} (${dl.label}) has ${missing.length} unimported track(s), retrying import`);
      const n = await importDownload(dl);
      setStatus(dl.id, 'done', n > 1 ? `Imported ${n} tracks to your library` : 'Added to your library', { progress: 1 });
    } catch (err) {
      log.debug(`sweep: #${dl.id} retry failed: ${err.message}`);
    } finally {
      pendingImports.delete(dl.id);
    }
  }

  // Re-drive searches that failed only because slskd was temporarily down
  // (status 'error', nothing ever started transferring). Retry once slskd is
  // healthy again, at most every 30 min per download, for up to a day.
  let healthy = false;
  try { healthy = await slskdReady(); } catch { /* treat as not healthy */ }
  if (healthy) {
    const retry = db.prepare(`
      SELECT * FROM downloads
      WHERE status = 'error' AND slskd_user IS NULL
        AND updated_at > datetime('now','-1 days')
    `).all();
    for (const dl of retry) {
      const last = sweepAttempts.get(dl.id) || 0;
      if (Date.now() - last < 30 * 60 * 1000) continue;
      sweepAttempts.set(dl.id, Date.now());
      log.info(`sweep: re-searching #${dl.id} (${dl.label}) after a transient slskd outage`);
      setStatus(dl.id, 'searching', 'Retrying after slskd recovered');
      runSearch(dl.id);
    }
  }
}

function walkAudio(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAudio(full));
    else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function safeName(s) {
  let out = (s || 'unknown').replace(/[/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  // Never let a metadata value become a path-traversal component ("." / "..").
  if (out === '.' || out === '..' || out === '') out = '_';
  return out;
}

const normTitle = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Drop parentheticals/featurings that often differ between Deezer's title and
// a peer's filename (and would over-constrain a Soulseek search).
function cleanForSearch(s) {
  return (s || '')
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Ordered, de-duplicated Soulseek queries from most specific to broadest.
 *  Soulseek requires every term to be present in the path, so we fall back to
 *  the bare title — peers often don't name the artist in the folder. */
function searchVariants(artist, title) {
  const withArtist = t => (normTitle(t).includes(normTitle(artist)) || !artist) ? t : `${artist} ${t}`;
  const deAccent = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ct = cleanForSearch(title);
  const out = [
    withArtist(title), withArtist(ct),
    deAccent(withArtist(ct)),                 // accent-insensitive ("Morphée" -> "Morphee")
    title, ct, deAccent(ct),
    // Last resort: scan the artist's shared files and let scoring + the
    // post-download duration check find the right take. Catches odd spellings
    // like "High Way" vs "Highway" that strict title terms miss.
    artist,
  ];
  return [...new Set(out.map(s => s.trim()).filter(Boolean))];
}

/** Best-effort track number from a filename: handles "03 - x", "03. x",
 *  "03_x", "3 x", and disc-prefixed "1-03 x" / "1.03 x". */
function fileTrackNo(base) {
  const name = base.replace(/\.[^.]+$/, '');
  let m = name.match(/^\s*\d{1,2}\s*[-_.]\s*(\d{1,3})(?:\D|$)/); // disc-track
  if (m) return parseInt(m[1], 10);
  m = name.match(/^\s*(\d{1,3})(?:\D|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/** True when a downloaded file's title/name plausibly matches a wanted title,
 *  in either direction (handles "(feat. …)" and punctuation differences). */
function titleMatches(fi, wantTitle) {
  const wt = normTitle(wantTitle);
  if (!wt) return false;
  const ft = normTitle(fi.title);
  const fb = normTitle(fi.base);
  return (ft && (ft.includes(wt) || wt.includes(ft))) || fb.includes(wt);
}

/** Locate the completed slskd files on disk (by basename, anywhere under the
 *  slskd download dir) and hardlink the matching tracks into the root folder. */
async function importDownload(dl) {
  const plan = pendingImports.get(dl.id);
  const remotePaths = plan?.slskdFiles || slskdFilesOf(dl);
  const wantedNames = remotePaths.map(f => f.split(/[\\/]/).pop());
  log.info(`#${dl.id} importing ${wantedNames.length} slskd file(s) from ${config.slskdDownloadDir}`);

  // Search the peer's own download subfolder(s) first — slskd writes each
  // transfer under a directory named after the remote folder — and only fall
  // back to the whole tree. This avoids grabbing an identically-named file that
  // belongs to a different download.
  const remoteDirs = [...new Set(remotePaths
    .map(f => f.split(/[\\/]/).slice(-2, -1)[0])  // immediate parent folder name
    .filter(Boolean))];
  let scoped = [];
  for (const d of remoteDirs) {
    const dir = path.join(config.slskdDownloadDir, safeName(d));
    if (fs.existsSync(dir)) scoped.push(...walkAudio(dir));
  }
  const all = scoped.length ? scoped : walkAudio(config.slskdDownloadDir);
  const files = [];
  for (const name of wantedNames) {
    const hit = all.find(f => path.basename(f) === name)
      || all.find(f => normTitle(path.basename(f)) === normTitle(name))
      // Last resort: widen to the full tree if a scoped search missed it.
      || (scoped.length && walkAudio(config.slskdDownloadDir).find(f => path.basename(f) === name));
    if (hit && !files.includes(hit)) files.push(hit);
  }
  if (!files.length) {
    throw new Error(`Completed Soulseek file(s) not found under ${config.slskdDownloadDir} — check the slskd download directory points at slskd's downloads volume`);
  }

  // Read metadata for each downloaded file once. Track number comes from the
  // tag when present, otherwise from the filename.
  const fileInfos = [];
  for (const f of files) {
    const base = path.basename(f);
    let title = path.basename(f, path.extname(f));
    let trackNo = null, duration = null, isrc = null;
    try {
      const mm = await parseFile(f, { duration: true });
      title = mm.common.title || title;
      trackNo = mm.common.track?.no ?? null;
      duration = mm.format?.duration ?? null;          // actual audio length, in seconds
      isrc = (Array.isArray(mm.common.isrc) ? mm.common.isrc[0] : mm.common.isrc) || null;
    } catch { /* fall back to filename */ }
    if (trackNo == null) trackNo = fileTrackNo(base);
    fileInfos.push({ path: f, title, trackNo, base, duration, isrc });
  }

  const wanted = plan?.wantedTracks || [];
  let imported = 0;

  // Duration is the most reliable proof that a file is the RIGHT recording: a
  // wrong, edited, live or remixed take almost always differs in length. We
  // reject files whose actual duration contradicts Deezer's, and otherwise
  // prefer the closest match. (null = can't judge, e.g. unknown duration.)
  const durTol = w => Math.max(7, (w || 0) * 0.05);
  const durVerdict = (want, fi) => {
    if (!want.duration || !fi.duration) return null;
    return Math.abs(fi.duration - want.duration) <= durTol(want.duration);
  };

  // ISRC is a unique code for a specific recording, so when both the Deezer
  // track and the downloaded file carry one it's definitive proof of same/other
  // recording — sharper than duration (it tells an original from a same-length
  // remix). Tags vary in punctuation/case, so normalize to the bare 12 chars.
  const normIsrc = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isrcVerdict = (want, fi) => {
    const a = normIsrc(want.isrc), b = normIsrc(fi.isrc);
    if (a.length !== 12 || b.length !== 12) return null;   // can't judge
    return a === b;
  };

  // Combined confidence that file `fi` IS the wanted recording. Negative means
  // "proven wrong" (reject); higher positive means stronger proof.
  const confidence = (want, fi) => {
    const i = isrcVerdict(want, fi);
    if (i === false) return -1;        // ISRC proves a different recording
    const d = durVerdict(want, fi);
    if (d === false) return -1;        // duration proves a different length
    if (i === true) return 3;          // ISRC confirms the exact recording
    if (d === true) return 2;          // duration confirms the length
    return 1;                          // nothing contradicts it
  };
  const pickMatch = (want) => {
    const cands = fileInfos.filter(fi => !fi.used && (
      (want.track_position && fi.trackNo === want.track_position) || titleMatches(fi, want.title)));
    const ranked = cands
      .map(fi => ({ fi, c: confidence(want, fi) }))
      .filter(x => x.c >= 0)                            // drop ISRC/duration-proven mismatches
      .sort((a, b) => {
        if (a.c !== b.c) return b.c - a.c;              // strongest proof first (ISRC > duration)
        const da = (a.fi.duration && want.duration) ? Math.abs(a.fi.duration - want.duration) : 1e9;
        const db2 = (b.fi.duration && want.duration) ? Math.abs(b.fi.duration - want.duration) : 1e9;
        return da - db2;                                // then closest length
      });
    return ranked[0]?.fi || null;
  };

  // Link one downloaded file into the library for a wanted track.
  const linkInto = (want, fi) => {
    fi.used = true;
    const ext = path.extname(fi.path);
    const destDir = path.join(config.musicDir, safeName(want.artist), safeName(want.album || 'Singles'));
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${safeName(want.title)}${ext}`);
    // Hardlink into the root folder (instant, no extra disk space). Falls back
    // to a copy when the slskd download dir and root folder are on different
    // filesystems.
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.linkSync(fi.path, dest);
    } catch (e) {
      if (e.code === 'EXDEV' || e.code === 'EPERM') {
        try { fs.copyFileSync(fi.path, dest); }
        catch (e2) { try { fs.rmdirSync(destDir); } catch { /* keep if non-empty */ } throw new Error(`Copy failed: ${e2.message}`); }
      } else {
        try { fs.rmdirSync(destDir); } catch { /* keep if non-empty */ }
        throw new Error(`Hardlink failed: ${e.message}`);
      }
    }
    // Record the exact source so deletion can reclaim it later even if the
    // downloaded filename differs from the library name (or the download row
    // is gone).
    db.prepare('UPDATE tracks SET file_path = ?, source_path = ?, in_library = 1 WHERE deezer_id = ?').run(dest, fi.path, want.deezer_id);
    log.info(`#${dl.id} imported "${want.artist} - ${want.title}" -> ${dest}`);
    imported++;
  };

  const unmatched = [];
  for (const want of wanted) {
    // If we already have this track's file globally, just reuse it.
    const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(want.deezer_id);
    if (have?.file_path && fs.existsSync(have.file_path)) { imported++; continue; }

    // Match a downloaded file to this wanted track by track number / title,
    // gated and ranked by actual duration.
    let match = pickMatch(want);
    // A single-file download: assume it's the song the user asked for even when
    // tag/filename matching failed — but only if the duration doesn't contradict it.
    if (!match && fileInfos.length === 1 && !fileInfos[0].used
        && (wanted.length === 1 || want.deezer_id === plan?.requiredId)
        && confidence(want, fileInfos[0]) >= 0) {
      match = fileInfos[0];
    }
    if (!match) { unmatched.push(want); continue; }
    linkInto(want, match);
  }

  // Positional fallback for albums: if some tracks still didn't match (messy
  // tags/filenames) but there are leftover files, line them up in track order.
  // Only when the leftover counts line up closely, to avoid mislabeling.
  if (unmatched.length && dl.kind === 'album') {
    const freeFiles = fileInfos.filter(fi => !fi.used)
      .sort((a, b) => (a.trackNo ?? 1e9) - (b.trackNo ?? 1e9) || a.base.localeCompare(b.base));
    const need = [...unmatched].sort((a, b) => (a.track_position ?? 1e9) - (b.track_position ?? 1e9));
    if (freeFiles.length && Math.abs(freeFiles.length - need.length) <= 1) {
      log.info(`#${dl.id} positional fallback: assigning ${Math.min(freeFiles.length, need.length)} leftover file(s) by track order`);
      for (let i = 0; i < need.length && i < freeFiles.length; i++) {
        if (confidence(need[i], freeFiles[i]) < 0) continue; // never mislabel (length/ISRC)
        linkInto(need[i], freeFiles[i]);
      }
    }
  }

  for (const want of unmatched) {
    if (!db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(want.deezer_id)?.file_path) {
      log.debug(`#${dl.id} no file matched "${want.artist} - ${want.title}"`);
    }
  }

  // Clean up files we downloaded but did NOT import — wrong candidates,
  // verification rejects, duplicates of tracks we already had, and (for albums)
  // junk that doesn't belong to the release. For a track download every extra is
  // wrong; for an album we keep unused files that still plausibly match a wanted
  // track (a real track that merely failed to auto-match) to avoid losing music.
  const junk = fileInfos.filter(fi => !fi.used).filter(fi =>
    dl.kind !== 'album'
      ? true
      : !wanted.some(w => titleMatches(fi, w.title) || durVerdict(w, fi) === true)
  ).map(fi => fi.path);
  for (const p of junk) {
    try { fs.unlinkSync(p); log.info(`#${dl.id} removed unused download: ${path.basename(p)}`); }
    catch (e) { log.debug(`#${dl.id} could not remove ${p}: ${e.message}`); }
  }

  if (imported === 0) {
    throw Object.assign(
      new Error(`Downloaded ${fileInfos.length} file(s) but none matched/verified against the ${wanted.length} requested track(s)`),
      { failover: true });
  }
  // For a track download, the download only counts as done if the song the
  // user asked for actually made it in (right title AND right duration).
  if (plan?.requiredId) {
    const got = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(plan.requiredId);
    if (!got?.file_path || !fs.existsSync(got.file_path)) {
      throw Object.assign(
        new Error(`The downloaded file didn't match the requested song (wrong title or duration) — trying another source`),
        { failover: true });
    }
  }
  log.info(`#${dl.id} import complete: ${imported}/${wanted.length} track(s)`);
  return imported;
}

/** Reconcile the catalog with what's actually on disk in the root folder so the
 *  library reflects reality: drop file paths whose file vanished, and re-link
 *  known tracks whose file is present at the expected path (e.g. after the DB
 *  lost the link). Returns a small summary. */
export function scanLibrary() {
  const root = config.musicDir;
  let pruned = 0, relinked = 0;

  for (const t of db.prepare('SELECT deezer_id, file_path FROM tracks WHERE file_path IS NOT NULL').all()) {
    if (!fs.existsSync(t.file_path)) {
      db.prepare('UPDATE tracks SET file_path = NULL WHERE deezer_id = ?').run(t.deezer_id);
      pruned++;
    }
  }

  for (const t of db.prepare('SELECT deezer_id, artist, album, title FROM tracks WHERE file_path IS NULL').all()) {
    const dir = path.join(root, safeName(t.artist), safeName(t.album || 'Singles'));
    if (!fs.existsSync(dir)) continue;
    const want = safeName(t.title);
    const hit = fs.readdirSync(dir).find(f =>
      AUDIO_EXT.has(path.extname(f).toLowerCase()) && path.basename(f, path.extname(f)) === want);
    if (hit) {
      db.prepare('UPDATE tracks SET file_path = ? WHERE deezer_id = ?').run(path.join(dir, hit), t.deezer_id);
      relinked++;
    }
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE file_path IS NOT NULL').get().n;
  log.info(`library scan: ${total} track(s) on disk in ${root} (relinked ${relinked}, pruned ${pruned} missing)`);
  return { total, relinked, pruned };
}

/** On boot, resume polling for anything that was mid-flight. */
export function resumeOnBoot() {
  const stuck = db.prepare(`SELECT * FROM downloads WHERE status = 'searching'`).all();
  for (const dl of stuck) runSearch(dl.id);
  // Rebuild import plans for active transfers from Deezer.
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND slskd_user IS NOT NULL`).all();
  for (const dl of active) rebuildPlan(dl).catch(() => {});
}

/** Delete a track's audio from disk. Because import hardlinks the file into the
 *  library, the same bytes usually exist under both the root folder and slskd's
 *  download dir — remove both names so the space is actually reclaimed. Returns
 *  a summary of what was removed. */
/** Remove now-empty directories above a deleted file, climbing up to (but never
 *  removing or escaping) the library/download roots. */
function pruneEmptyDirs(filePath) {
  if (!filePath) return;
  const roots = [path.resolve(config.musicDir), path.resolve(config.slskdDownloadDir)];
  let dir = path.dirname(path.resolve(filePath));
  const root = roots.find(r => dir === r || dir.startsWith(r + path.sep));
  if (!root) return;
  while (dir.startsWith(root + path.sep) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); dir = path.dirname(dir); }
      else break;
    } catch { break; }
  }
}

export function deleteTrackFile(deezerId) {
  const row = db.prepare('SELECT file_path, source_path FROM tracks WHERE deezer_id = ?').get(deezerId);
  if (!row) return { removed: [], notFound: true };
  const removed = [];
  const tryUnlink = (p) => {
    try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); return true; } }
    catch (e) { log.warn(`delete: could not remove ${p}: ${e.message}`); }
    return false;
  };

  // Capture the library file's inode BEFORE deleting it: the slskd download is
  // usually a hardlink to the same inode, so we can find it even if its filename
  // differs from the library name (and no download row survives).
  const inodeKey = (p) => { try { const s = fs.statSync(p); return `${s.dev}:${s.ino}`; } catch { return null; } };
  const srcInode = inodeKey(row.file_path) || inodeKey(row.source_path);

  // 1) The library copy and 2) the exact original download.
  tryUnlink(row.file_path);
  const sourceRemoved = tryUnlink(row.source_path);

  // 3) If the original download wasn't reclaimed above — no source_path was
  // recorded, or it has since been moved/renamed — locate the leftover(s) under
  // the slskd download dir by inode (hardlink) or basename, so a deleted track
  // never lingers in slskd's folder.
  if (!sourceRemoved) {
    const wantBases = new Set();
    if (row.source_path) wantBases.add(path.basename(row.source_path));
    if (row.file_path) wantBases.add(path.basename(row.file_path));
    const dls = db.prepare(`SELECT slskd_file FROM downloads WHERE deezer_id = ? AND slskd_file IS NOT NULL`).all(deezerId);
    for (const d of dls) for (const f of slskdFilesOf({ slskd_file: d.slskd_file })) wantBases.add(f.split(/[\\/]/).pop());
    for (const f of walkAudio(config.slskdDownloadDir)) {
      if (removed.includes(f)) continue;
      if (wantBases.has(path.basename(f)) || (srcInode && inodeKey(f) === srcInode)) tryUnlink(f);
    }
  }

  // Clean up folders left empty by the deletion (e.g. Artist/Album).
  for (const p of [row.file_path, row.source_path, ...removed]) pruneEmptyDirs(p);

  db.prepare('UPDATE tracks SET file_path = NULL, source_path = NULL, in_library = 0 WHERE deezer_id = ?').run(deezerId);
  log.info(`#del track ${deezerId}: removed ${removed.length} file(s)`);
  return { removed, notFound: false };
}

async function rebuildPlan(dl) {
  let wantedTracks, requiredId = null;
  if (dl.kind === 'album') {
    const album = await deezerGet(`album/${dl.deezer_id}`);
    wantedTracks = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
  } else {
    const tr = await deezerGet(`track/${dl.deezer_id}`);
    wantedTracks = [trackRowFromDeezer(tr)];
    requiredId = dl.deezer_id;
  }
  wantedTracks.forEach(upsertTrack);
  pendingImports.set(dl.id, {
    wantedTracks, kind: dl.kind, requiredId,
    slskdUser: dl.slskd_user, slskdFiles: slskdFilesOf(dl),
  });
}
