// Pure, framework-free helpers — no React/DOM, so they're unit-testable under
// the Node test runner (see web/test/). Re-exported from store.jsx for existing
// import sites.

/** Format a number of seconds as m:ss, or "--:--" for unknown/empty input. */
export function fmtTime(sec) {
  if (!sec && sec !== 0) return '--:--';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------- Alphabetical indexing */
// Buckets used by the A–Z rail beside large artist/album grids. '#' collects
// everything that doesn't start with a latin letter (digits, symbols, and
// non-latin scripts such as Cyrillic or CJK).
export const INDEX_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

const LEADING_ARTICLE = /^(?:the|a|an|le|la|les|el|los|las|der|die|das|il|lo|l)\s+/;

/** Normalise a display name for alphabetical sorting: drops diacritics and
 *  leading punctuation, ignores a leading article ("The Beatles" → "beatles"),
 *  and lowercases. Falls back to the un-stripped name when stripping would
 *  leave nothing (e.g. an artist actually called "The"). */
export function sortName(name) {
  const base = String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
    .toLowerCase();
  return base.replace(LEADING_ARTICLE, '').trim() || base;
}

/** The index bucket a name falls into: 'A'–'Z', or '#' for anything else. */
export function indexLetter(name) {
  const c = sortName(name).charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

/** Group items into alphabetical sections, ordered A–Z then '#'. Items inside
 *  a section are sorted by their normalised name. Empty letters are omitted —
 *  the rail renders those as disabled keys from INDEX_LETTERS. */
export function groupByLetter(items, getName = (x) => x?.name) {
  const buckets = new Map();
  for (const item of items || []) {
    const letter = indexLetter(getName(item));
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push(item);
  }
  const out = [];
  for (const letter of INDEX_LETTERS) {
    const group = buckets.get(letter);
    if (!group) continue;
    group.sort((a, b) => {
      const an = sortName(getName(a)), bn = sortName(getName(b));
      return an.localeCompare(bn) || String(getName(a) ?? '').localeCompare(String(getName(b) ?? ''));
    });
    out.push({ letter, items: group });
  }
  return out;
}

// Catalog ids at or above this base come from MusicBrainz rather than Deezer.
// Mirrors MB_ID_BASE in server/db.js — the client only needs it to know which
// Deezer-only affordances to hide.
export const MB_ID_BASE = 1e12;

/** Whether a 30-second preview can exist for this track.
 *
 *  Previews are Deezer's clips; MusicBrainz is a metadata database with no
 *  audio, so a track sourced from it has nothing to preview. The id is checked
 *  as well as `source` because not every shape the UI handles carries one. */
export function hasPreview(track) {
  if (!track) return false;
  if (track.source === 'musicbrainz') return false;
  return Number(track.deezer_id ?? track.id ?? 0) < MB_ID_BASE;
}
