import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, config, upsertTrack, trackRowFromDeezer } from './db.js';
import { deezerGet, jackettSearch, scoreResults, tmAdd, tmStatus } from './sources.js';

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma']);

function setStatus(id, status, detail, extra = {}) {
  const fields = { status, detail: detail ?? null, ...extra };
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE downloads SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ id, ...fields });
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
  startSearch(id).catch(e => setStatus(id, 'error', String(e.message || e)));
  return id;
}

async function startSearch(downloadId) {
  const dl = db.prepare('SELECT * FROM downloads WHERE id = ?').get(downloadId);
  if (!dl) return;

  // 1. Resolve what we need from Deezer (artist, title, and for albums the
  //    full tracklist so we can match files later).
  let artist, title, wantedTracks;
  if (dl.kind === 'album') {
    const album = await deezerGet(`album/${dl.deezer_id}`);
    artist = album.artist?.name || '';
    title = album.title || '';
    wantedTracks = (album.tracks?.data || []).map(t => trackRowFromDeezer(t, album));
    wantedTracks.forEach(upsertTrack);
  } else {
    const tr = await deezerGet(`track/${dl.deezer_id}`);
    artist = tr.artist?.name || '';
    title = tr.title || '';
    const row = trackRowFromDeezer(tr);
    upsertTrack(row);
    wantedTracks = [row];

    // If the file already exists from a previous download, finish instantly.
    const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(dl.deezer_id);
    if (have?.file_path && fs.existsSync(have.file_path)) {
      return setStatus(downloadId, 'done', 'Already in library', { progress: 1 });
    }
  }

  // 2. Search Jackett. For a single track, an album release is acceptable —
  //    we'll just keep the one file we need.
  setStatus(downloadId, 'searching', 'Searching indexers');
  const queries = dl.kind === 'album'
    ? [`${artist} ${title}`, title]
    : [`${artist} ${title}`, `${artist} ${title} album`];

  let best = null;
  for (const q of queries) {
    const results = await jackettSearch(q);
    const scored = scoreResults(results, artist, dl.kind === 'album' ? title : title);
    if (scored.length) { best = scored[0]; break; }
  }
  if (!best) return setStatus(downloadId, 'not_found', 'No matching release found');

  // 3. Hand off to Transmission.
  const link = best.result.MagnetUri || best.result.Link;
  const subdir = `tonearr-${downloadId}`;
  setStatus(downloadId, 'downloading', `Found: ${best.result.Title}`, {
    release_title: best.result.Title, progress: 0,
  });
  const t = await tmAdd(link, subdir);
  setStatus(downloadId, 'downloading', `Found: ${best.result.Title}`, { torrent_hash: t.hashString });

  // Remember which tracks this download is responsible for importing.
  pendingImports.set(downloadId, { wantedTracks, subdir, kind: dl.kind, deezerId: dl.deezer_id });
}

// downloadId -> import plan, kept in memory while torrents are active.
const pendingImports = new Map();

/* ------------------------------------------------------------ Poll loop */
export function startPoller() {
  setInterval(() => tick().catch(e => console.error('[poll]', e)), config.pollIntervalMs);
}

async function tick() {
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND torrent_hash IS NOT NULL`).all();
  if (!active.length) return;
  const hashes = active.map(d => d.torrent_hash);
  let torrents = [];
  try { torrents = await tmStatus(hashes); } catch (e) { return; }
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
      await importDownload(dl, t);
      setStatus(dl.id, 'done', 'Added to your library', { progress: 1 });
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

async function importDownload(dl, torrent) {
  const plan = pendingImports.get(dl.id);
  const srcDir = path.join(config.downloadDir, `tonearr-${dl.id}`);
  const files = walkAudio(srcDir);
  if (!files.length) throw new Error('No audio files in the completed download');

  // Read metadata for each downloaded file once.
  const fileInfos = [];
  for (const f of files) {
    let title = path.basename(f, path.extname(f));
    let trackNo = null;
    try {
      const mm = await parseFile(f, { duration: false });
      title = mm.common.title || title;
      trackNo = mm.common.track?.no ?? null;
    } catch { /* fall back to filename */ }
    fileInfos.push({ path: f, title, trackNo, base: path.basename(f) });
  }

  const wanted = plan?.wantedTracks || [];
  let imported = 0;

  for (const want of wanted) {
    // If we already have this track's file globally, just reuse it.
    const have = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(want.deezer_id);
    if (have?.file_path && fs.existsSync(have.file_path)) { imported++; continue; }

    // Match a downloaded file to this wanted track: prefer track number, then
    // fuzzy title containment.
    let match = null;
    if (want.track_position) match = fileInfos.find(fi => fi.trackNo === want.track_position && !fi.used);
    if (!match) {
      const wt = normTitle(want.title);
      match = fileInfos.find(fi => !fi.used && wt && (normTitle(fi.title).includes(wt) || normTitle(fi.base).includes(wt)));
    }
    // Single-track download with a single audio file: take it.
    if (!match && wanted.length === 1 && fileInfos.length === 1) match = fileInfos[0];
    if (!match) continue;
    match.used = true;

    const ext = path.extname(match.path);
    const destDir = path.join(config.musicDir, safeName(want.artist), safeName(want.album || 'Singles'));
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${safeName(want.title)}${ext}`);
    try {
      fs.copyFileSync(match.path, dest);
    } catch (e) {
      throw new Error(`Copy failed: ${e.message}`);
    }
    db.prepare('UPDATE tracks SET file_path = ? WHERE deezer_id = ?').run(dest, want.deezer_id);
    imported++;
  }

  if (imported === 0) throw new Error('Downloaded files did not match the requested tracks');
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
    const tr = await deezerGet(`track/${dl.deezer_id}`);
    wantedTracks = [trackRowFromDeezer(tr)];
  }
  wantedTracks.forEach(upsertTrack);
  pendingImports.set(dl.id, { wantedTracks, subdir: `tonearr-${dl.id}`, kind: dl.kind, deezerId: dl.deezer_id });
}
