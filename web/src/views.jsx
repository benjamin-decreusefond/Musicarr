// Public surface of the app's views. Implementations live in ./views/*,
// split by domain (mirroring server/routes/*):
//   home.jsx      — landing page
//   search.jsx    — unified Deezer + people search
//   browse.jsx    — artist / album pages, Explore / Mood / Genre
//   library.jsx   — Library tabs, Liked songs, followed artists
//   playlists.jsx — local playlists (+ sharing), Deezer playlist preview
//   downloads.jsx — download queue
//   mixes.jsx     — made-for-you mixes
//   stats.jsx     — listening stats
//   profile.jsx   — own profile, avatar, language, password, API tokens
//   settings.jsx  — admin server settings
//   admin.jsx     — user management, library health
//   social.jsx    — other users' profiles, follow/user rows
//   shared.jsx    — useAsync + loading/error states + shared widgets
export { Home } from './views/home.jsx';
export { Search } from './views/search.jsx';
export { Artist, Album, Explore, Mood, Genre } from './views/browse.jsx';
export { Library, Favorites, Following } from './views/library.jsx';
export { Playlist, DeezerPlaylist } from './views/playlists.jsx';
export { Downloads } from './views/downloads.jsx';
export { MadeForYou, Mix } from './views/mixes.jsx';
export { Stats } from './views/stats.jsx';
export { Profile } from './views/profile.jsx';
export { Settings } from './views/settings.jsx';
export { Admin, LibraryHealth } from './views/admin.jsx';
export { UserProfile } from './views/social.jsx';
