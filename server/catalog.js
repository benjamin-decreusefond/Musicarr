// The catalog, whichever service a row came from.
//
// Deezer is still the catalog for almost everything, but a release Deezer has
// never heard of can now come from MusicBrainz instead (see musicbrainz.js).
// Both produce the same shape, so the six places that used to call
// `deezerGet('track/…')` or `deezerGet('album/…')` call these instead and stop
// caring which service answered.
//
// The id itself says where to look: anything at or above MB_ID_BASE is a
// MusicBrainz row. That keeps the dispatch out of every call site and out of
// the request payloads — a client asks for a track by id exactly as before.
import { isMbId } from './db.js';
import { deezerGet } from './sources.js';
import { musicbrainzTrack, musicbrainzAlbum } from './musicbrainz.js';

/** One track, shaped like a Deezer track. */
export function catalogTrack(id) {
  return isMbId(id) ? musicbrainzTrack(id) : deezerGet(`track/${id}`);
}

/** One album with its tracklist, shaped like a Deezer album. */
export function catalogAlbum(id) {
  return isMbId(id) ? musicbrainzAlbum(id) : deezerGet(`album/${id}`);
}

/** Where a catalog id comes from, for anything that needs to say so. */
export const catalogSource = (id) => (isMbId(id) ? 'musicbrainz' : 'deezer');
