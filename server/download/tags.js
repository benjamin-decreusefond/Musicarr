// Tagging stage: stamp the metadata Musicarr actually knows (from Deezer) onto
// the downloaded audio file, so the library is correct for *every* player —
// Jellyfin, a car head unit, a phone — and not just for Musicarr, which reads
// titles from SQLite and never needs the tags.
//
// Soulseek files arrive with whatever tags the sharing peer happened to have:
// missing album art, "Track 03" titles, transliterated artist names, or nothing
// at all. We rewrite them with ffmpeg in a lossless remux (`-c copy`): the audio
// bitstream is copied byte-for-byte, only the metadata container is rebuilt.
//
// The file is tagged in place *before* it is hardlinked into the library, which
// is deliberate: ffmpeg cannot edit in place, so it writes a temporary file that
// then replaces the original. Doing that before the link keeps the library and
// the slskd download dir sharing a single inode (Musicarr's "a file is only ever
// stored once" property). Tagging after the link would leave two full copies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../log.js';

const log = logger('tags');

// Containers ffmpeg can remux losslessly while replacing the metadata.
export const TAGGABLE = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.opus']);
// Of those, the ones that can carry the cover as an attached picture stream.
// Ogg/Opus store art as a base64 comment ffmpeg won't write, so they get tags only.
const ART_CAPABLE = new Set(['.mp3', '.flac', '.m4a', '.mp4']);

// A cover is a JPEG off Deezer's CDN; anything much bigger than this isn't one.
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const COVER_TIMEOUT_MS = 15000;
// A remux is I/O-bound and should take well under a second; this only exists so
// a wedged ffmpeg can't pin an import forever.
const FFMPEG_TIMEOUT_MS = 120000;

/** Tag values go on an ffmpeg command line: drop control characters (a newline
 *  would split the value) and cap the length so a pathological title can't blow
 *  past the argument limit. */
const clean = (v) => {
  if (v === null || v === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  return s || null;
};

/** Deezer serves cover art at the size embedded in the URL (we store the 250px
 *  one for the UI). Ask for a 1000px version for the file itself — that's what
 *  ends up on a TV or a car screen. Falls back to the original URL untouched. */
export function coverUrlForFile(url) {
  return typeof url === 'string' ? url.replace(/\/\d{2,4}x\d{2,4}-/, '/1000x1000-') : url;
}

/** Download cover art, or null if it isn't usable. Never throws: art is a
 *  nice-to-have and must not fail an import. */
export async function fetchCover(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const r = await fetch(coverUrlForFile(url), { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // Only trust a real JPEG (FF D8 FF): ffmpeg would reject anything else, and
    // an error page returned with a 200 is a real possibility.
    if (buf.length < 4 || buf.length > MAX_COVER_BYTES) return null;
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return null;
    return buf;
  } catch {
    return null;
  }
}

/** The ffmpeg command line for one remux. Pure, so the mapping from track
 *  metadata to tags can be asserted directly in tests. */
export function ffmpegArgs({ src, dest, coverPath, track }) {
  const ext = path.extname(dest).toLowerCase();
  const meta = [];
  const add = (key, value) => { const v = clean(value); if (v !== null) meta.push('-metadata', `${key}=${v}`); };
  add('title', track.title);
  add('artist', track.artist);
  add('album', track.album);
  // Album artist keeps compilations and features filed under one album instead
  // of splitting it per-track in other players' library views.
  add('album_artist', track.album_artist || track.artist);
  if (track.track_position) add('track', track.track_total ? `${track.track_position}/${track.track_total}` : String(track.track_position));
  if (track.disk_number) add('disc', String(track.disk_number));
  // The ISRC identifies the exact recording; it is what lets a later dedup pass
  // tell an original from a remix that shares title and length.
  add('ISRC', track.isrc);
  if (ext === '.mp3') add('TSRC', track.isrc);
  // Original release date, and the MusicBrainz identifiers Picard, Jellyfin,
  // Plex and Beets key on — with these, another tool recognises the file
  // outright instead of re-guessing what it is (see musicbrainz.js).
  add('date', track.release_date);
  add('MUSICBRAINZ_TRACKID', track.mb_recording_id);
  add('MUSICBRAINZ_ALBUMID', track.mb_release_id);
  add('MUSICBRAINZ_ARTISTID', track.mb_artist_id);

  return [
    '-nostdin', '-loglevel', 'error', '-y',
    '-i', src,
    ...(coverPath ? ['-i', coverPath] : []),
    '-map', '0:a',
    ...(coverPath ? ['-map', '1:v'] : []),
    // Drop whatever the peer had; the Deezer metadata below is the source of truth.
    '-map_metadata', '-1',
    '-c', 'copy',
    ...(coverPath ? ['-disposition:v:0', 'attached_pic'] : []),
    // ID3v2.3 is the version Windows Explorer and older car stereos actually read.
    ...(ext === '.mp3' ? ['-id3v2_version', '3'] : []),
    ...meta,
    dest,
  ];
}

/** Run ffmpeg, resolving on exit code 0 and rejecting otherwise. */
export function runFfmpeg(args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(); };
    const timer = setTimeout(() => { ff.kill('SIGKILL'); finish(new Error(`ffmpeg timed out after ${timeoutMs}ms`)); }, timeoutMs);
    ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    ff.on('error', (e) => finish(new Error(`ffmpeg could not be started (${e.message}) — is it installed?`)));
    ff.on('close', (code) => finish(code === 0 ? null : new Error(`ffmpeg exited ${code}: ${stderr.trim() || 'no output'}`)));
  });
}

/** Rewrite `filePath`'s tags from `track` (a Deezer track row), embedding
 *  `cover` (a JPEG buffer) when the container supports it.
 *
 *  Returns true when the file was rewritten, false when it was left untouched.
 *  Never throws: a tagging failure must never lose a downloaded file, so every
 *  error path keeps the original and just reports it. */
export async function writeTags(filePath, track, { cover = null } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TAGGABLE.has(ext)) {
    log.debug(`skipping tags for ${path.basename(filePath)}: ${ext || 'no extension'} is not remuxable`);
    return false;
  }

  // Temporaries live next to the file so the final rename stays on one
  // filesystem (an atomic replace, never a cross-device copy).
  const dir = path.dirname(filePath);
  const stem = path.join(dir, `.musicarr-tag-${process.pid}-${Date.now()}`);
  const tmpOut = `${stem}${ext}`;
  const tmpCover = cover && ART_CAPABLE.has(ext) ? `${stem}.jpg` : null;
  const cleanup = () => {
    for (const f of [tmpOut, tmpCover]) {
      if (f) { try { fs.unlinkSync(f); } catch { /* nothing to remove */ } }
    }
  };

  try {
    if (tmpCover) fs.writeFileSync(tmpCover, cover);
    try {
      await runFfmpeg(ffmpegArgs({ src: filePath, dest: tmpOut, coverPath: tmpCover, track }));
    } catch (e) {
      // Cover art is the fragile half (an odd JPEG, a muxer that refuses the
      // stream). Losing the art is much better than losing the tags, so retry
      // once without it before giving up.
      if (!tmpCover) throw e;
      log.debug(`retrying ${path.basename(filePath)} without embedded art: ${e.message}`);
      try { fs.unlinkSync(tmpOut); } catch { /* never created */ }
      await runFfmpeg(ffmpegArgs({ src: filePath, dest: tmpOut, track }));
    }
    // Sanity check before clobbering the original: an ffmpeg that "succeeded"
    // into an empty file must not replace real audio.
    if (!fs.statSync(tmpOut).size) throw new Error('ffmpeg produced an empty file');
    fs.renameSync(tmpOut, filePath);
    return true;
  } catch (e) {
    log.warn(`could not write tags for ${path.basename(filePath)}: ${e.message}`);
    return false;
  } finally {
    cleanup();
  }
}
