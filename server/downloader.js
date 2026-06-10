import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, config, upsertTrack, trackRowFromDeezer } from './db.js';
import { deezerGet, jackettSearch, scoreResults, tmAdd, tmStatus } from './sources.js';
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

/**
 * Queue a download. `kind` is 'album' or 'track'. Returns the download row id.
 * The actual work happens asynchronously in startSearch().
 */
export function queueDownload(userId, kind, deezerId, label, cover) {
  // Already have the file(s)? Then it's instant for this user.
  const existing = db.prepare('INSERT INTO downloads (user_id, kind, deezer_id, label, cover) VALUES (?, ?, ?, ?, ?)')
    .run(userId, kind, deezerId, label, cover || null);
  const id = existing.lastInsertRowid;
  log.info(`#${id} queued ${kind} ${deezerId} by user ${userId}: ${label}`);
  startSearch(id).catch(e => { log.error(`#${id} startSearch failed`, e); setStatus(id, 'error', String(e.message || e)); });
  return id;
}

async function startSearch(downloadId) {
  const dl = db.prepare('SELECT * FROM downloads WHERE id = ?').get(downloadId);
  if (!dl) return;

  // 1. Resolve what we need from Deezer (artist, title, and for albums the
  //    full tracklist so we can match files later). `attempts` is an ordered
  //    list of { query, matchTitle } pairs — each query is scored against the
  //    title that the release name is expected to contain.
  let artist, title, wantedTracks, attempts;
  if (dl.kind === 'album') {
    const album = await deezerGet(`album/${dl.deezer_id}`);
    artist = album.artist?.name || '';
    title = album.title || '';
    wantedTracks = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
    wantedTracks.forEach(upsertTrack);
    attempts = [
      { query: `${artist} ${title}`, matchTitle: title },
      { query: title, matchTitle: title },
    ];
  } else {
    const tr = await deezerGet(`track/${dl.deezer_id}`);
    artist = tr.artist?.name || '';
    title = tr.title || '';
    const albumTitle = tr.album?.title || '';
    const row = trackRowFromDeezer(tr);
    upsertTrack(row);

    // If the file already exists from a previous download, finish instantly.
    const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(dl.deezer_id);
    if (have?.file_path && fs.existsSync(have.file_path)) {
      return setStatus(downloadId, 'done', 'Already in library', { progress: 1 });
    }

    // Releases are usually full albums, so plan for the whole tracklist: any
    // sibling track that comes along in the download gets imported too, and a
    // later request for one of them completes instantly from the library.
    wantedTracks = [row];
    if (tr.album?.id) {
      try {
        const album = await deezerGet(`album/${tr.album.id}`);
        const all = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
        if (all.length) { all.forEach(upsertTrack); wantedTracks = all; }
      } catch (e) {
        log.warn(`#${downloadId} could not fetch album ${tr.album.id} tracklist, importing the single track only: ${e.message}`);
      }
    }

    // Try the track itself first, but trackers almost always carry the full
    // album rather than single tracks — so fall back to the track's album and
    // let the import step keep what it can match.
    attempts = [{ query: `${artist} ${title}`, matchTitle: title }];
    if (albumTitle) {
      attempts.push({ query: `${artist} ${albumTitle}`, matchTitle: albumTitle });
      attempts.push({ query: albumTitle, matchTitle: albumTitle });
    }
  }

  // 2. Search Jackett, trying each query until one yields a viable release.
  setStatus(downloadId, 'searching', 'Searching indexers');
  let best = null;
  for (const { query, matchTitle } of attempts) {
    log.info(`#${downloadId} searching Jackett: "${query}" (match against "${matchTitle}")`);
    const results = await jackettSearch(query);
    const scored = scoreResults(results, artist, matchTitle);
    log.info(`#${downloadId} "${query}": ${results.length} results, ${scored.length} viable`);
    if (scored.length) { best = scored[0]; break; }
  }
  if (!best) {
    log.warn(`#${downloadId} no viable release for "${artist} - ${title}" (categories: ${config.searchCategories.join(',')})`);
    return setStatus(downloadId, 'not_found',
      dl.kind === 'track' ? 'No release found for the track or its album' : 'No matching release found');
  }

  // 3. Hand off to Transmission.
  const link = best.result.MagnetUri || best.result.Link;
  const subdir = subdirFor(dl);
  log.info(`#${downloadId} best release (score ${Math.round(best.score)}): ${best.result.Title}`);
  setStatus(downloadId, 'downloading', `Found: ${best.result.Title}`, {
    release_title: best.result.Title, progress: 0,
  });
  const t = await tmAdd(link, subdir);
  log.info(`#${downloadId} handed to Transmission, hash ${t.hashString}, dir ${config.downloadDir}/${subdir}`);
  setStatus(downloadId, 'downloading', `Found: ${best.result.Title}`, { torrent_hash: t.hashString });

  // Remember which tracks this download is responsible for importing. For a
  // track download `requiredId` is the song the user actually asked for; the
  // rest of the album is imported opportunistically.
  pendingImports.set(downloadId, {
    wantedTracks, subdir, kind: dl.kind, deezerId: dl.deezer_id,
    requiredId: dl.kind === 'track' ? dl.deezer_id : null,
  });
}

// downloadId -> import plan, kept in memory while torrents are active.
const pendingImports = new Map();

/** Download folder name: readable in Transmission's UI, and deterministic
 *  from the DB row so the import step can find it again after a reboot. */
function subdirFor(dl) {
  return `musicarr-${dl.id}-${safeName(dl.label)}`;
}

/* ------------------------------------------------------------ Poll loop */
export function startPoller() {
  log.info(`poll loop started, every ${config.pollIntervalMs}ms (unimported-files sweep every ${config.sweepIntervalMs}ms)`);
  setInterval(() => tick().catch(e => log.error('poll tick failed', e)), config.pollIntervalMs);
  // Recover completed downloads whose import never happened (crash mid-import,
  // matching bug, plan lost across a restart, ...): shortly after boot, then
  // periodically.
  setTimeout(() => sweepUnimported().catch(e => log.error('sweep failed', e)), Math.min(15000, config.sweepIntervalMs));
  setInterval(() => sweepUnimported().catch(e => log.error('sweep failed', e)), config.sweepIntervalMs);
}

let sweeping = false;
const failedSweeps = new Map(); // srcDir -> dir mtime at last failed attempt
/** Scan the download dir for musicarr-<id> folders whose download row has
 *  tracks that never made it into the library, and retry the import. */
export async function sweepUnimported() {
  if (sweeping) return;
  sweeping = true;
  try {
    let entries = [];
    try { entries = fs.readdirSync(config.downloadDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^musicarr-(\d+)/);
      if (!m) continue;
      const dl = db.prepare('SELECT * FROM downloads WHERE id = ?').get(parseInt(m[1], 10));
      if (!dl) continue;                                  // dismissed download; leave files for seeding
      if (!['done', 'error', 'importing'].includes(dl.status)) continue; // active ones belong to the poller
      const srcDir = path.join(config.downloadDir, e.name);
      // Don't re-attempt a folder that already failed unless it changed.
      const mtime = fs.statSync(srcDir).mtimeMs;
      if (failedSweeps.get(srcDir) === mtime) continue;
      try {
        if (!pendingImports.has(dl.id)) await rebuildPlan(dl);
        const plan = pendingImports.get(dl.id);
        const missing = (plan?.wantedTracks || []).filter(w => {
          const t = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(w.deezer_id);
          return !(t?.file_path && fs.existsSync(t.file_path));
        });
        if (!missing.length) continue;
        log.info(`sweep: download #${dl.id} (${dl.label}) has ${missing.length} unimported track(s), retrying import from ${e.name}`);
        const n = await importDownload(dl, null, srcDir);
        failedSweeps.delete(srcDir);
        setStatus(dl.id, 'done', n > 1 ? `Imported ${n} tracks to your library` : 'Added to your library', { progress: 1 });
      } catch (err) {
        failedSweeps.set(srcDir, mtime);
        // Keep quiet at info level: a permanently unmatchable folder would
        // otherwise log an error every sweep.
        log.debug(`sweep: #${dl.id} retry failed: ${err.message}`);
      } finally {
        pendingImports.delete(dl.id);
      }
    }
  } finally {
    sweeping = false;
  }
}

async function tick() {
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND torrent_hash IS NOT NULL`).all();
  if (!active.length) return;
  const hashes = active.map(d => d.torrent_hash);
  let torrents = [];
  try {
    torrents = await tmStatus(hashes);
  } catch (e) {
    log.warn(`could not reach Transmission to poll ${active.length} active download(s): ${e.message}`);
    return;
  }
  const byHash = new Map(torrents.map(t => [t.hashString, t]));

  for (const dl of active) {
    const t = byHash.get(dl.torrent_hash);
    if (!t) continue;
    if (t.errorString) { setStatus(dl.id, 'error', t.errorString); continue; }
    if (t.percentDone < 1) {
      if (Math.abs(t.percentDone - dl.progress) > 0.01) setStatus(dl.id, 'downloading', dl.detail, { progress: t.percentDone });
      continue;
    }
    // Download finished -> import.
    setStatus(dl.id, 'importing', 'Importing files', { progress: 1 });
    try {
      const n = await importDownload(dl, t);
      setStatus(dl.id, 'done', n > 1 ? `Imported ${n} tracks to your library` : 'Added to your library', { progress: 1 });
    } catch (e) {
      setStatus(dl.id, 'error', String(e.message || e));
    }
    pendingImports.delete(dl.id);
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
  return (s || 'unknown').replace(/[/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

const normTitle = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

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
 *  in either direction (handles "(feat. \u2026)" and punctuation differences). */
function titleMatches(fi, wantTitle) {
  const wt = normTitle(wantTitle);
  if (!wt) return false;
  const ft = normTitle(fi.title);
  const fb = normTitle(fi.base);
  return (ft && (ft.includes(wt) || wt.includes(ft))) || fb.includes(wt);
}

async function importDownload(dl, torrent, srcDirOverride = null) {
  const plan = pendingImports.get(dl.id);
  // Downloads queued before the descriptive folder names landed live in the
  // bare `musicarr-<id>` directory; fall back to it.
  let srcDir = srcDirOverride || path.join(config.downloadDir, subdirFor(dl));
  if (!fs.existsSync(srcDir)) {
    const legacy = path.join(config.downloadDir, `musicarr-${dl.id}`);
    if (fs.existsSync(legacy)) srcDir = legacy;
  }
  log.info(`#${dl.id} importing from ${srcDir}`);
  const files = walkAudio(srcDir);
  log.info(`#${dl.id} found ${files.length} audio file(s) in download`);
  if (!files.length) {
    const exists = fs.existsSync(srcDir);
    throw new Error(exists
      ? `No audio files found in ${srcDir} — check that DOWNLOAD_DIR/Transmission download directory points at the same storage`
      : `Download directory ${srcDir} does not exist on Musicarr's side — the download dir and Transmission must share the same volume/path`);
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
    // Hardlink into the root folder (instant, no extra disk space, and the
    // torrent keeps seeding from the download dir). Falls back to a copy when
    // the download dir and root folder are on different filesystems.
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
    db.prepare('UPDATE tracks SET file_path = ? WHERE deezer_id = ?').run(dest, want.deezer_id);
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
    // A release with a single audio file: assume it's the song the user asked
    // for, even when tag/filename matching failed.
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
  // For a track download, sibling album tracks are a bonus — but the download
  // only counts as done if the song the user asked for actually made it in.
  if (plan?.requiredId) {
    const got = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(plan.requiredId);
    if (!got?.file_path || !fs.existsSync(got.file_path)) {
      throw new Error(`Imported ${imported} other track(s) from the release, but the requested song was not in it`);
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

/** On boot, resume polling for anything that was mid-flight. Imports for those
 *  will be recovered by re-reading the download dir on completion. */
export function resumeOnBoot() {
  const stuck = db.prepare(`SELECT * FROM downloads WHERE status IN ('searching','importing')`).all();
  for (const dl of stuck) {
    // Re-kick searches that never reached Transmission.
    if (dl.status === 'searching' && !dl.torrent_hash) {
      startSearch(dl.id).catch(e => setStatus(dl.id, 'error', String(e.message || e)));
    }
  }
  // Rebuild import plans for active torrents from Deezer lazily on next tick.
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND torrent_hash IS NOT NULL`).all();
  for (const dl of active) rebuildPlan(dl).catch(() => {});
}

async function rebuildPlan(dl) {
  let wantedTracks;
  if (dl.kind === 'album') {
    const album = await deezerGet(`album/${dl.deezer_id}`);
    wantedTracks = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
  } else {
    // Same as startSearch: plan for the whole album so sibling tracks in the
    // downloaded release get imported too.
    const tr = await deezerGet(`track/${dl.deezer_id}`);
    wantedTracks = [trackRowFromDeezer(tr)];
    if (tr.album?.id) {
      try {
        const album = await deezerGet(`album/${tr.album.id}`);
        const all = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
        if (all.length) wantedTracks = all;
      } catch { /* single track plan is still fine */ }
    }
  }
  wantedTracks.forEach(upsertTrack);
  pendingImports.set(dl.id, {
    wantedTracks, subdir: subdirFor(dl), kind: dl.kind, deezerId: dl.deezer_id,
    requiredId: dl.kind === 'track' ? dl.deezer_id : null,
  });
}
