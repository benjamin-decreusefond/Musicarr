// Import stage: locate completed slskd files on disk, verify them against the
// requested tracks (see match.js), and hardlink the winners into the library.
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, config, upsertTrack, trackRowFromDeezer } from '../db.js';
import { deezerGet } from '../sources.js';
import { logger } from '../log.js';
import { walkAudio, safeName, normTitle, titleMatches, slskdFilesOf, fileTrackNo, fileDiscNo } from './util.js';
import { confidence, durVerdict, pickMatch } from './match.js';

const log = logger('download');

// downloadId -> import plan, kept in memory while transfers are active.
export const pendingImports = new Map();
// downloadId -> { pct, at } — last observed progress, for the stall guard.
export const progressTrack = new Map();

/** Locate the completed slskd files on disk (by basename, anywhere under the
 *  slskd download dir) and hardlink the matching tracks into the root folder. */
export async function importDownload(dl) {
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
    let trackNo = null, disc = null, duration = null, isrc = null;
    try {
      const mm = await parseFile(f, { duration: true });
      title = mm.common.title || title;
      trackNo = mm.common.track?.no ?? null;
      disc = mm.common.disk?.no ?? null;
      duration = mm.format?.duration ?? null;          // actual audio length, in seconds
      isrc = (Array.isArray(mm.common.isrc) ? mm.common.isrc[0] : mm.common.isrc) || null;
    } catch { /* fall back to filename */ }
    if (trackNo == null) trackNo = fileTrackNo(base);
    if (disc == null) disc = fileDiscNo(f);
    fileInfos.push({ path: f, title, trackNo, disc, base, duration, isrc });
  }

  const wanted = plan?.wantedTracks || [];
  let imported = 0;

  // Playlist imports (to_library = 0) leave their tracks as "Available" instead
  // of promoting every song into the shared Library view.
  const promote = dl.to_library == null || !!dl.to_library;

  // Link one downloaded file into the library for a wanted track.
  const linkInto = (want, fi) => {
    fi.used = true;
    const ext = path.extname(fi.path);
    const destDir = path.join(config.musicDir, safeName(want.artist), safeName(want.album || 'Singles'));
    fs.mkdirSync(destDir, { recursive: true });
    // Two different tracks can sanitize to the same "Title.ext" (reprises,
    // deluxe duplicates). tracks.file_path is UNIQUE, and blindly unlinking the
    // existing file would replace the other track's audio — so when the plain
    // name is owned by a DIFFERENT track, disambiguate with the track number,
    // then with the Deezer id as a last resort.
    const ownedByOther = (p) => {
      const owner = db.prepare('SELECT deezer_id FROM tracks WHERE file_path = ?').get(p);
      return owner && owner.deezer_id !== want.deezer_id;
    };
    let dest = path.join(destDir, `${safeName(want.title)}${ext}`);
    if (ownedByOther(dest)) {
      const num = want.track_position ? `${String(want.track_position).padStart(2, '0')} - ` : '';
      dest = path.join(destDir, `${num}${safeName(want.title)}${ext}`);
      if (ownedByOther(dest)) dest = path.join(destDir, `${safeName(want.title)} (${want.deezer_id})${ext}`);
    }
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
    // is gone). in_library is only raised for downloads meant for the Library.
    db.prepare('UPDATE tracks SET file_path = ?, source_path = ?, in_library = CASE WHEN ? THEN 1 ELSE in_library END WHERE deezer_id = ?')
      .run(dest, fi.path, promote ? 1 : 0, want.deezer_id);
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
    let match = pickMatch(want, fileInfos);
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
      .sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.trackNo ?? 1e9) - (b.trackNo ?? 1e9) || a.base.localeCompare(b.base));
    const need = [...unmatched].sort((a, b) =>
      (a.disk_number ?? 1) - (b.disk_number ?? 1) || (a.track_position ?? 1e9) - (b.track_position ?? 1e9));
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

/** Rebuild the in-memory import plan for a download from Deezer (used after a
 *  restart, when the plan created at search time is gone). */
export async function rebuildPlan(dl) {
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
