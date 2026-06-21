import { Router } from 'express';
import { requireAuth } from './auth.js';
import { registerSettings } from './routes/settings.js';
import { registerLibrary } from './routes/library.js';
import { registerBrowse } from './routes/browse.js';
import { registerDownloads } from './routes/downloads.js';
import { registerFavorites } from './routes/favorites.js';
import { registerPlaylists } from './routes/playlists.js';
import { registerActivity } from './routes/activity.js';
import { registerDiscovery } from './routes/discovery.js';
import { registerMedia } from './routes/media.js';

// The signed-in API surface. Routes live in ./routes/*, grouped by domain;
// each register* call mounts its handlers onto this shared router (preserving
// the original registration order).
export const api = Router();
api.use(requireAuth);

registerSettings(api);   // /settings*
registerLibrary(api);    // /library*, /library/:trackId, track-status helpers
registerBrowse(api);     // /search, /artist, /album, /home, /explore, /mood, /genre, /following
registerDownloads(api);  // /download, /downloads
registerFavorites(api);  // /favorites
registerPlaylists(api);  // /playlists* (+ sharing, Deezer import)
registerActivity(api);   // /plays, /history, /preferences, /stats
registerDiscovery(api);  // /mixes, /recommendations, /radio, /track-status
registerMedia(api);      // /avatar, /preview, /lyrics, /stream
