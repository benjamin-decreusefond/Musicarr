// Import an existing music collection: walk the root folder for audio files
// Musicarr doesn't know about, identify each one from its tags (falling back
// to the Artist/Album folder layout and the filename), match it to a Deezer
// track, and link the file into the catalog in place — no copying or moving.
//
// Matching is deliberately conservative: a file is only linked when the found
// Deezer track agrees on title/artist and (when both are known) duration, so a
// wrong match never poisons the library. Unmatched files are counted and
// reported, never touched.
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db, config, upsertTrack, trackRowFromDeezer } from './db.js';
import { deezerGet } from './sources.js';
import { publish } from './events.js';
import { logger } from './log.js';

const log = logger('scan');

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma']);

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

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Strip a leading track number ("03 - ", "1-03.", "07_") from a filename-derived title.
const stripTrackNo = s => s.replace(/^\s*\d{1,2}([-_. ]\s*\d{1,3})?\s*[-_.]\s*/, '').trim();

/** Identify a file from its tags, with folder/filename fallbacks for untagged
 *  files laid out as .../Artist/Album/Track.ext. */
async function identify(file, root) {
  let title = stripTrackNo(path.basename(file, path.extname(file)));
  let artist = null, album = null, duration = null;
  try {
    const mm = await parseFile(file, { duration: true });
    title = mm.common.title || title;
    artist = mm.common.artist || mm.common.albumartist || null;
    album = mm.common.album || null;
    duration = mm.format?.duration ?? null;
  } catch { /* untagged/corrupt tags: fall back to the path */ }
  if (!artist) {
    const rel = path.relative(root, file).split(path.sep);
    if (rel.length >= 3) { artist = rel[0]; album = album || rel[1]; }
    else if (rel.length === 2) artist = rel[0];
  }
  return { title, artist, album, duration };
}

/** Pick the Deezer hit that actually IS this file: title and artist must agree
 *  (normalized, either direction), and when both durations are known they must
 *  be within tolerance. Returns null when nothing qualifies. */
function pickBest(hits, info) {
  const wantT = norm(info.title), wantA = norm(info.artist);
  let best = null, bestScore = -1;
  for (const h of hits || []) {
    const ht = norm(h.title), ha = norm(h.artist?.name);
    if (!ht || !(ht.includes(wantT) || wantT.includes(ht))) continue;
    if (wantA && ha && !(ha.includes(wantA) || wantA.includes(ha))) continue;
    if (info.duration && h.duration && Math.abs(h.duration - info.duration) > Math.max(7, h.duration * 0.05)) continue;
    let score = (ht === wantT ? 2 : 1) + (ha === wantA ? 2 : 0);
    if (info.duration && h.duration) score += 2 - Math.min(2, Math.abs(h.duration - info.duration) / 10);
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

// One scan at a time; progress is polled by the Settings UI (and mirrored over
// SSE for connected admins).
export const scanState = {
  running: false, startedAt: null, finishedAt: null,
  total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, error: null,
  unmatched: [], // [{ file, reason }] from the last scan (capped), for the health page
};

const UNMATCHED_CAP = 200;
function noteUnmatched(root, file, reason) {
  scanState.skipped++;
  if (scanState.unmatched.length < UNMATCHED_CAP) {
    scanState.unmatched.push({ file: path.relative(root, file), reason });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Start a background import scan. Throws if one is already running. */
export function startImportScan() {
  if (scanState.running) throw new Error('A scan is already running');
  Object.assign(scanState, {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, error: null,
    unmatched: [],
  });
  runScan()
    .catch(e => { scanState.error = String(e.message || e); log.error('import scan failed', e); })
    .finally(() => {
      scanState.running = false;
      scanState.finishedAt = new Date().toISOString();
      publish('scan', { ...scanState }, { adminOnly: true });
      log.info(`import scan finished: ${scanState.imported} imported, ${scanState.skipped} skipped, ${scanState.failed} failed of ${scanState.total}`);
    });
  return scanState;
}

async function runScan() {
  const root = config.musicDir;
  const known = new Set(
    db.prepare('SELECT file_path FROM tracks WHERE file_path IS NOT NULL').all().map(r => r.file_path)
  );
  const files = walkAudio(root).filter(f => !known.has(f));
  scanState.total = files.length;
  log.info(`import scan: ${files.length} unknown audio file(s) under ${root}`);

  for (const file of files) {
    scanState.processed++;
    try {
      const info = await identify(file, root);
      if (!info.title) { noteUnmatched(root, file, 'No usable title in tags or filename'); continue; }

      // Advanced search first (exact-ish), then a plain query as fallback.
      let hits = [];
      if (info.artist) {
        const q = `artist:"${info.artist}" track:"${info.title}"`;
        hits = (await deezerGet(`search/track?q=${encodeURIComponent(q)}&limit=10`)).data || [];
      }
      if (!hits.length) {
        const q = [info.artist, info.title].filter(Boolean).join(' ');
        hits = (await deezerGet(`search/track?q=${encodeURIComponent(q)}&limit=10`)).data || [];
      }
      const best = pickBest(hits, info);
      if (!best) { noteUnmatched(root, file, 'No confident Deezer match'); log.debug(`no confident match for ${file}`); continue; }

      // Another file already owns this Deezer track -> this one is a duplicate.
      const existing = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(best.id);
      if (existing?.file_path && fs.existsSync(existing.file_path)) {
        noteUnmatched(root, file, `Duplicate of "${best.artist?.name} - ${best.title}"`);
        continue;
      }

      upsertTrack(trackRowFromDeezer(best));
      db.prepare('UPDATE tracks SET file_path = ?, in_library = 1 WHERE deezer_id = ?').run(file, best.id);
      scanState.imported++;
      log.info(`imported "${best.artist?.name} - ${best.title}" <- ${path.relative(root, file)}`);
    } catch (e) {
      scanState.failed++;
      log.warn(`import scan: ${file}: ${e.message}`);
    }
    // Progress push every few files so the UI moves without hammering SSE.
    if (scanState.processed % 5 === 0 || scanState.processed === scanState.total) {
      publish('scan', { ...scanState }, { adminOnly: true });
    }
    await sleep(120); // stay well inside Deezer's rate limit
  }
}
