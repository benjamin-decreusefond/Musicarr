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

  for (const q of queries) {
    log.info(`#${dl.id} slskd search: "${q}"`);
    let files = [];
    try { files = await slskdSearch(q); }
    catch (e) { log.warn(`#${dl.id} slskd search failed: ${e.message}`); continue; }
    const ranked = scoreSlskdFiles(files, row.artist, row.title, tr.duration || null)
      .filter(f => !isExcluded(dl, f.username, f.filename));
    log.info(`#${dl.id} "${q}": ${files.length} audio file(s), ${ranked.length} viable`);

    if (ranked.length) await ensureSlskdReady(dl.id);
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
      }
    }
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

  setStatus(dl.id, 'searching', 'Searching Soulseek');
  const queries = searchVariants(artist, title);
  for (const q of queries) {
    log.info(`#${dl.id} slskd album search: "${q}"`);
    let files = [];
    try { files = await slskdSearch(q); }
    catch (e) { log.warn(`#${dl.id} slskd search failed: ${e.message}`); continue; }

    // Rank per-peer folders by how much of the tracklist they cover.
    const folders = scoreSlskdFolders(files, wantedTracks.map(w => w.title))
      .filter(f => !isExcluded(dl, f.username, f.files[0]?.filename));
    log.info(`#${dl.id} "${q}": ${files.length} file(s) in ${folders.length} viable folder(s)`);

    if (folders.length) await ensureSlskdReady(dl.id);
    for (const folder of folders.slice(0, 5)) {
      try {
        await enqueueWithRetry(dl.id, folder.username, folder.files);
        const dirBase = folder.directory.split(/[\\/]/).pop() || folder.directory;
        log.info(`#${dl.id} slskd queued folder "${dirBase}" (${folder.files.length} files, covers ${folder.matched}/${wantedTracks.length}) from ${folder.username}`);
        setStatus(dl.id, 'downloading', `Soulseek: ${dirBase} (${folder.files.length} files)`, {
          slskd_user: folder.username,
          slskd_file: JSON.stringify(folder.files.map(f => f.filename)),
          release_title: dirBase, progress: 0,
        });
        pendingImports.set(dl.id, {
          wantedTracks, kind: 'album', requiredId: null,
          slskdUser: folder.username, slskdFiles: folder.files.map(f => f.filename),
        });
        return;
      } catch (e) {
        log.warn(`#${dl.id} slskd peer ${folder.username} rejected the folder: ${e.message}`);
      }
    }
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
  const ct = cleanForSearch(title);
  const out = [withArtist(title), withArtist(ct), title, ct];
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
    let trackNo = null;
    try {
      const mm = await parseFile(f, { duration: false });
      title = mm.common.title || title;
      trackNo = mm.common.track?.no ?? null;
    } catch { /* fall back to filename */ }
    if (trackNo == null) trackNo = fileTrackNo(base);
    fileInfos.push({ path: f, title, trackNo, base });
  }

  const wanted = plan?.wantedTracks || [];
  let imported = 0;

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
        catch (e2) { throw new Error(`Copy failed: ${e2.message}`); }
      } else {
        throw new Error(`Hardlink failed: ${e.message}`);
      }
    }
    db.prepare('UPDATE tracks SET file_path = ?, in_library = 1 WHERE deezer_id = ?').run(dest, want.deezer_id);
    log.info(`#${dl.id} imported "${want.artist} - ${want.title}" -> ${dest}`);
    imported++;
  };

  const unmatched = [];
  for (const want of wanted) {
    // If we already have this track's file globally, just reuse it.
    const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(want.deezer_id);
    if (have?.file_path && fs.existsSync(have.file_path)) { imported++; continue; }

    // Match a downloaded file to this wanted track: prefer track number (tag or
    // filename), then bidirectional title matching.
    let match = null;
    if (want.track_position) match = fileInfos.find(fi => !fi.used && fi.trackNo === want.track_position);
    if (!match) match = fileInfos.find(fi => !fi.used && titleMatches(fi, want.title));
    // A single-file download: assume it's the song the user asked for, even
    // when tag/filename matching failed.
    if (!match && fileInfos.length === 1 && !fileInfos[0].used
        && (wanted.length === 1 || want.deezer_id === plan?.requiredId)) {
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
      for (let i = 0; i < need.length && i < freeFiles.length; i++) linkInto(need[i], freeFiles[i]);
    }
  }

  for (const want of unmatched) {
    if (!db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(want.deezer_id)?.file_path) {
      log.debug(`#${dl.id} no file matched "${want.artist} - ${want.title}"`);
    }
  }

  if (imported === 0) {
    throw new Error(`Downloaded ${fileInfos.length} file(s) but none matched the ${wanted.length} requested track(s)`);
  }
  // For a track download, the download only counts as done if the song the
  // user asked for actually made it in.
  if (plan?.requiredId) {
    const got = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(plan.requiredId);
    if (!got?.file_path || !fs.existsSync(got.file_path)) {
      throw new Error(`Imported ${imported} other track(s), but the requested song was not among them`);
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
export function deleteTrackFile(deezerId) {
  const row = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(deezerId);
  if (!row) return { removed: [], notFound: true };
  const removed = [];
  const tryUnlink = (p) => {
    try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); } } catch (e) { log.warn(`delete: could not remove ${p}: ${e.message}`); }
  };

  // 1) The library copy.
  tryUnlink(row.file_path);

  // 2) The original slskd download(s) for this track, located by basename under
  // the slskd download dir (the other end of the hardlink).
  const dls = db.prepare(`SELECT slskd_file FROM downloads WHERE deezer_id = ? AND slskd_file IS NOT NULL`).all(deezerId);
  const wantBases = new Set();
  for (const d of dls) for (const f of slskdFilesOf({ slskd_file: d.slskd_file })) wantBases.add(f.split(/[\\/]/).pop());
  // Also match the library file's own basename, covering album downloads where
  // slskd_file lists every track on one row.
  if (row.file_path) wantBases.add(path.basename(row.file_path));
  if (wantBases.size) {
    for (const f of walkAudio(config.slskdDownloadDir)) {
      if (wantBases.has(path.basename(f)) && !removed.includes(f)) tryUnlink(f);
    }
  }

  db.prepare('UPDATE tracks SET file_path = NULL, in_library = 0 WHERE deezer_id = ?').run(deezerId);
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
