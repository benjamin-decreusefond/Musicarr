// What "better" means for an audio file, in one place.
//
// Musicarr used to have a single hard filter (any / mp3 / flac). That answers
// "what may I download", but not "is the copy I already have good enough" —
// which is the question an upgrade sweep has to ask about every track in the
// library. Both now come from the same profile.
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { config, AUDIO_FORMATS, LOSSLESS_FORMATS } from './db.js';

/** The container of a path, normalized: '/a/b/Song.FLAC' -> 'flac'. */
export const formatOf = (filePath) => path.extname(filePath || '').slice(1).toLowerCase();

// music-metadata names containers the way the spec does ('WAVE', 'MPEG',
// 'MPEG-4'), not the way filenames do. Mapping them keeps one vocabulary across
// the profile, the database and the UI.
const CONTAINERS = {
  flac: 'flac', wave: 'wav', wav: 'wav', mpeg: 'mp3', mp3: 'mp3',
  'mpeg-4': 'm4a', m4a: 'm4a', ogg: 'ogg', opus: 'opus',
  aac: 'aac', adts: 'aac', asf: 'wma', 'asf/audio': 'wma',
};

/** The format of a parsed file: what the decoder found, falling back to the
 *  extension when the container name isn't one we recognise. Peers rename files,
 *  so the extension is a claim and the container is evidence — but only when we
 *  can actually map it. */
export function containerOf(mmFormat, filePath) {
  // Opus lives inside an Ogg container, so the container alone can't tell them
  // apart; the codec can.
  if (String(mmFormat?.codec || '').toLowerCase().includes('opus')) return 'opus';
  const key = String(mmFormat?.container || '').toLowerCase();
  const mapped = CONTAINERS[key] || (key.includes('m4a') || key.includes('isom') ? 'm4a' : null);
  return mapped || formatOf(filePath) || null;
}

/** Read a file's real format and bitrate (kbps). Returns nulls rather than
 *  throwing: a file we can't parse is still a file we can play, and this runs
 *  over whole libraries where one broken header must not stop the pass. */
export async function readAudioQuality(filePath) {
  try {
    const mm = await parseFile(filePath);
    const bps = mm.format?.bitrate;
    return {
      format: containerOf(mm.format, filePath),
      bitrate: Number.isFinite(bps) ? Math.round(bps / 1000) : null,
    };
  } catch {
    return { format: formatOf(filePath) || null, bitrate: null };
  }
}

/** Bitrate of a slskd search result in kbps. slskd reports one for most MP3s;
 *  when it doesn't, size and length give a usable estimate. */
export function candidateBitrate(f) {
  if (Number.isFinite(f?.bitRate) && f.bitRate > 0) return f.bitRate;
  if (Number.isFinite(f?.size) && Number.isFinite(f?.length) && f.length > 0) {
    return Math.round((f.size * 8) / f.length / 1000);
  }
  return null;
}

/** A predicate over slskd search results: true when the candidate is something
 *  the profile is willing to download at all.
 *
 *  A missing bitrate is *not* treated as a failure. slskd frequently omits it,
 *  and rejecting everything unmeasurable would empty the candidate list for
 *  whole swathes of the network — the duration and title gates in
 *  scoreSlskdFiles are what actually keep the wrong file out. */
export function qualityGate(profile = config.qualityProfile) {
  const accepted = new Set(profile.accepted || AUDIO_FORMATS);
  const min = profile.minBitrate || 0;
  return (f) => {
    const fmt = formatOf(f?.filename);
    if (!accepted.has(fmt)) return false;
    if (!min || LOSSLESS_FORMATS.has(fmt)) return true;
    const br = candidateBitrate(f);
    return br === null || br >= min;
  };
}

/** How strongly the profile prefers this format, as a ranking bonus spread
 *  evenly from 30 (first choice) down to 0 (last).
 *
 *  This replaces the ranking's old hardcoded "+20 if FLAC": that was the default
 *  preference expressed a second time, and it meant someone who deliberately put
 *  MP3 first still got FLACs. The spread is wide enough that the ordering wins
 *  outright, leaving the bitrate bonuses to separate files of the same format. */
export function formatPreference(filename, profile = config.qualityProfile) {
  const accepted = profile.accepted || AUDIO_FORMATS;
  const idx = accepted.indexOf(formatOf(filename));
  if (idx < 0) return 0;
  return accepted.length < 2 ? 30 : (30 * (accepted.length - 1 - idx)) / (accepted.length - 1);
}

/** Is a library file already as good as the profile's target?
 *
 *  Lossless is the ceiling: with a lossless target, a lossless file is done.
 *  With a lossy target, anything lossless is *better* than the target and is
 *  never downgraded — the point of a target is a floor to reach, not a format
 *  to force every file into. */
export function meetsTarget(track, { target = config.qualityTarget, minBitrate = config.qualityMinBitrate } = {}) {
  if (!target) return true;                       // nothing to aim at
  const fmt = (track.audio_format || '').toLowerCase();
  if (!fmt) return false;                         // unknown quality: worth a look
  if (LOSSLESS_FORMATS.has(fmt)) return true;
  if (LOSSLESS_FORMATS.has(target)) return false; // lossy file, lossless wanted
  if (fmt !== target) return false;
  return !minBitrate || (track.bitrate ?? 0) >= minBitrate;
}

/** The profile an upgrade search runs under: only the target format, so
 *  anything that comes back is by definition an improvement and the import can
 *  replace the old file without a second opinion. */
export function upgradeProfile() {
  return { accepted: [config.qualityTarget], minBitrate: config.qualityMinBitrate };
}
