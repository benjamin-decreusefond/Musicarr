// Verification and matching of downloaded files against the Deezer tracks the
// user asked for. Pure functions over { want, fileInfo } pairs — no I/O — so
// the rules that decide "is this the right recording?" are testable in
// isolation.
import { titleMatches } from './util.js';

// Duration is the most reliable proof that a file is the RIGHT recording: a
// wrong, edited, live or remixed take almost always differs in length. We
// reject files whose actual duration contradicts Deezer's, and otherwise
// prefer the closest match. (null = can't judge, e.g. unknown duration.)
const durTol = w => Math.max(7, (w || 0) * 0.05);
export function durVerdict(want, fi) {
  if (!want.duration || !fi.duration) return null;
  return Math.abs(fi.duration - want.duration) <= durTol(want.duration);
}

// ISRC is a unique code for a specific recording, so when both the Deezer
// track and the downloaded file carry one it's definitive proof of same/other
// recording — sharper than duration (it tells an original from a same-length
// remix). Tags vary in punctuation/case, so normalize to the bare 12 chars.
const normIsrc = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function isrcVerdict(want, fi) {
  const a = normIsrc(want.isrc), b = normIsrc(fi.isrc);
  if (a.length !== 12 || b.length !== 12) return null;   // can't judge
  return a === b;
}

/** Combined confidence that file `fi` IS the wanted recording. Negative means
 *  "proven wrong" (reject); higher positive means stronger proof. */
export function confidence(want, fi) {
  const i = isrcVerdict(want, fi);
  if (i === false) return -1;        // ISRC proves a different recording
  const d = durVerdict(want, fi);
  if (d === false) return -1;        // duration proves a different length
  if (i === true) return 3;          // ISRC confirms the exact recording
  if (d === true) return 2;          // duration confirms the length
  return 1;                          // nothing contradicts it
}

// Multi-disc guard: Deezer's track_position restarts on each disc, so a bare
// track-number match is ambiguous across discs. When both sides know their
// disc, require it to agree; when either side doesn't, fall through (duration
// and title still gate the match).
const discOk = (want, fi) =>
  want.disk_number == null || fi.disc == null || fi.disc === want.disk_number;

/** Best unused file for a wanted track: candidates match by track number /
 *  title, then are gated and ranked by confidence (ISRC > duration). */
export function pickMatch(want, fileInfos) {
  const cands = fileInfos.filter(fi => !fi.used && (
    (want.track_position && fi.trackNo === want.track_position && discOk(want, fi))
      || titleMatches(fi, want.title)));
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
}
