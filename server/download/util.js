// Shared helpers for the download pipeline: filename/path utilities, search
// query building, and small parsers used by both the search and import stages.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../db.js';

export const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma']);

// slskd transfer states: "Completed, Succeeded", "Completed, Errored", ...
export const TERMINAL = /Completed/i;
export const SUCCEEDED = /Succeeded/i;

/** The slskd_file column stores one filename (track) or a JSON array (album). */
export function slskdFilesOf(dl) {
  const raw = dl.slskd_file;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch { return [raw]; }
}

export function walkAudio(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAudio(full));
    else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

export function safeName(s) {
  let out = (s || 'unknown').replace(/[/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  // Never let a metadata value become a path-traversal component ("." / "..").
  if (out === '.' || out === '..' || out === '') out = '_';
  return out;
}

export const normTitle = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Drop parentheticals/featurings that often differ between Deezer's title and
// a peer's filename (and would over-constrain a Soulseek search).
export function cleanForSearch(s) {
  return (s || '')
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Ordered, de-duplicated Soulseek queries from most specific to broadest.
 *  Soulseek requires every term to be present in the path, so we fall back to
 *  the bare title — peers often don't name the artist in the folder. */
export function searchVariants(artist, title) {
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
export function fileTrackNo(base) {
  const name = base.replace(/\.[^.]+$/, '');
  let m = name.match(/^\s*\d{1,2}\s*[-_.]\s*(\d{1,3})(?:\D|$)/); // disc-track
  if (m) return parseInt(m[1], 10);
  m = name.match(/^\s*(\d{1,3})(?:\D|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Best-effort disc number from a filename ("1-03 x" / "1.03 x" -> 1), or from
 *  the parent folder ("CD2", "Disc 2"). Null when there's no disc hint. */
export function fileDiscNo(fullPath) {
  const base = fullPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  let m = base.match(/^\s*(\d{1,2})\s*[-_.]\s*\d{1,3}(?:\D|$)/);
  if (m) return parseInt(m[1], 10);
  const parent = fullPath.split(/[\\/]/).slice(-2, -1)[0] || '';
  m = parent.match(/\b(?:cd|disc|disk)\s*(\d{1,2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/** True when a downloaded file's title/name plausibly matches a wanted title,
 *  in either direction (handles "(feat. …)" and punctuation differences). */
export function titleMatches(fi, wantTitle) {
  const wt = normTitle(wantTitle);
  if (!wt) return false;
  const ft = normTitle(fi.title);
  const fb = normTitle(fi.base);
  return (ft && (ft.includes(wt) || wt.includes(ft))) || fb.includes(wt);
}

/** Remove now-empty directories above a deleted file, climbing up to (but never
 *  removing or escaping) the library/download roots. */
export function pruneEmptyDirs(filePath) {
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
