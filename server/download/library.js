// Library file management: reconcile the catalog with the disk, delete track
// files (reclaiming the slskd copy too), and the auto-cleanup of stale tracks.
import fs from 'node:fs';
import path from 'node:path';
import { db, config } from '../db.js';
import { logger } from '../log.js';
import { AUDIO_EXT, walkAudio, safeName, slskdFilesOf, pruneEmptyDirs } from './util.js';

const log = logger('download');

/** Remove downloaded tracks that haven't been played within the configured
 *  window. Favorited tracks, tracks in any playlist, and tracks a user pinned
 *  for offline playback are always kept. Tracks never played are aged from when
 *  they were added. Returns the count removed. */
export function cleanupStaleTracks() {
  if (!config.autoCleanupEnabled || config.cleanupAfterDays <= 0) return Promise.resolve(0);
  const days = config.cleanupAfterDays;
  const stale = db.prepare(`
    SELECT t.deezer_id, t.artist, t.title FROM tracks t
    WHERE t.file_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.deezer_id)
      AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.track_id = t.deezer_id)
      AND NOT EXISTS (SELECT 1 FROM offline_keeps ok WHERE ok.track_id = t.deezer_id)
      -- A pinned album protects its tracks too. (Pinned playlists need no clause
      -- here: their tracks are already spared by the playlist_items check above.)
      AND NOT EXISTS (
        SELECT 1 FROM offline_collections oc
        WHERE oc.kind = 'album' AND oc.collection_id = t.album_id
      )
      AND COALESCE((SELECT MAX(p.played_at) FROM plays p WHERE p.track_id = t.deezer_id), t.added_at)
            < datetime('now', ?)
  `).all(`-${days} days`);
  if (!stale.length) return Promise.resolve(0);
  log.info(`auto-cleanup: removing ${stale.length} track(s) not played in ${days} day(s)`);
  // Batch delete: one shared walk of the slskd tree for the whole run.
  let treeCache = null;
  const downloadTree = () => (treeCache ??= walkAudio(config.slskdDownloadDir));
  for (const t of stale) {
    try { deleteOneTrackFile(t.deezer_id, downloadTree); } catch (e) { log.warn(`auto-cleanup: ${t.artist} - ${t.title}: ${e.message}`); }
  }
  return Promise.resolve(stale.length);
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

  const taken = (p) => !!db.prepare('SELECT 1 FROM tracks WHERE file_path = ?').get(p);
  for (const t of db.prepare('SELECT deezer_id, artist, album, title, track_position FROM tracks WHERE file_path IS NULL').all()) {
    const dir = path.join(root, safeName(t.artist), safeName(t.album || 'Singles'));
    if (!fs.existsSync(dir)) continue;
    const want = safeName(t.title);
    // Accept the plain name and the collision-disambiguated variants that
    // linkInto may have produced ("NN - Title", "Title (deezerId)").
    const names = new Set([want, `${t.deezer_id ? `${want} (${t.deezer_id})` : want}`]);
    if (t.track_position) names.add(`${String(t.track_position).padStart(2, '0')} - ${want}`);
    const hit = fs.readdirSync(dir).find(f =>
      AUDIO_EXT.has(path.extname(f).toLowerCase()) && names.has(path.basename(f, path.extname(f)))
        && !taken(path.join(dir, f)));
    if (hit) {
      db.prepare('UPDATE tracks SET file_path = ? WHERE deezer_id = ?').run(path.join(dir, hit), t.deezer_id);
      relinked++;
    }
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE file_path IS NOT NULL').get().n;
  log.info(`library scan: ${total} track(s) on disk in ${root} (relinked ${relinked}, pruned ${pruned} missing)`);
  return { total, relinked, pruned };
}

/** Delete a track's audio from disk. Because import hardlinks the file into the
 *  library, the same bytes usually exist under both the root folder and slskd's
 *  download dir — remove both names so the space is actually reclaimed. Returns
 *  a summary of what was removed. */
export function deleteTrackFile(deezerId) {
  return deleteTrackFiles([deezerId])[0];
}

/** Batch variant: deletes several tracks while walking the slskd download tree
 *  AT MOST ONCE for the whole batch (the walk is the expensive part — the old
 *  per-track walk made a big auto-cleanup O(tracks × files)). */
export function deleteTrackFiles(deezerIds) {
  // Lazily-built, shared snapshot of the download tree. Files deleted earlier
  // in the batch are guarded by the existsSync check in tryUnlink.
  let treeCache = null;
  const downloadTree = () => (treeCache ??= walkAudio(config.slskdDownloadDir));
  return deezerIds.map(id => deleteOneTrackFile(id, downloadTree));
}

function deleteOneTrackFile(deezerId, downloadTree) {
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
  // never lingers in slskd's folder. Skipped entirely when there is nothing to
  // look for, so a metadata-only row never triggers a tree walk.
  if (!sourceRemoved) {
    const wantBases = new Set();
    if (row.source_path) wantBases.add(path.basename(row.source_path));
    if (row.file_path) wantBases.add(path.basename(row.file_path));
    const dls = db.prepare(`SELECT slskd_file FROM downloads WHERE deezer_id = ? AND slskd_file IS NOT NULL`).all(deezerId);
    for (const d of dls) for (const f of slskdFilesOf({ slskd_file: d.slskd_file })) wantBases.add(f.split(/[\\/]/).pop());
    if (wantBases.size || srcInode) {
      for (const f of downloadTree()) {
        if (removed.includes(f)) continue;
        if (wantBases.has(path.basename(f)) || (srcInode && inodeKey(f) === srcInode)) tryUnlink(f);
      }
    }
  }

  // Clean up folders left empty by the deletion (e.g. Artist/Album).
  for (const p of [row.file_path, row.source_path, ...removed]) pruneEmptyDirs(p);

  db.prepare('UPDATE tracks SET file_path = NULL, source_path = NULL, in_library = 0 WHERE deezer_id = ?').run(deezerId);
  log.info(`#del track ${deezerId}: removed ${removed.length} file(s)`);
  return { removed, notFound: false };
}
