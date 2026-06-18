# Musicarr

A self-hosted, Spotify-style music app that browses metadata from **Deezer**
(free, no API key) and downloads music from the **Soulseek** network through
**slskd**. Per-user playlists, favorites, and accounts; a single shared audio
library on disk with file deduplication; built-in streaming with HTTP range
support. State lives in **SQLite** — no Postgres required.

Soulseek shares **individual files**, so Musicarr downloads exactly what you
ask for: one song for a track, a whole folder from a single peer for an album.
No torrent client or indexers needed.

## How it works

1. You search. The UI shows artists, albums and tracks from Deezer with art.
2. You hit **download** on an album or a single track.
3. The server searches Soulseek via slskd and ranks the results — title/artist
   match, FLAC/320 bonus, free upload slot, queue length, duration sanity.
   For an album it ranks per-peer **folders** by how much of the tracklist
   they cover.
4. slskd transfers the file(s); Musicarr polls progress.
5. On completion, audio files are matched to the requested Deezer tracks (by
   track number, then fuzzy title) and **hardlinked** into
   `/music/Artist/Album/`.
6. The track is now streamable by **every** user — a file is only ever stored
   once. Favorites and playlists referencing it are per-user.

## Build the image

```bash
docker build -t musicarr:latest .
```

The build is multi-stage: it bundles the React frontend, compiles
`better-sqlite3`, and produces a runtime image that runs as the non-root `node`
user and exposes **port 8686**.

## Run

```bash
docker run -d --name musicarr -p 8686:8686 \
  -e SLSKD_URL=http://slskd:5030 \
  -e SLSKD_API_KEY=your_slskd_api_key \
  -e ADMIN_PASSWORD=change-me \
  -v musicarr-data:/data \
  -v /path/to/music:/music \
  -v /path/to/slskd-downloads:/slskd-downloads \
  musicarr:latest
```

### How downloads reach the library

The flow is: **slskd downloads → Musicarr hardlinks into the root folder →
the library streams from the root folder.**

Two paths, both configurable from **Settings**:

1. **slskd download directory** — slskd writes completed files to its own
   downloads folder; Musicarr imports from there. **Mount slskd's downloads
   volume into the Musicarr container** and point this setting at it.
2. **Root folder** — the library. On import, Musicarr **hardlinks** the audio
   files here, organized as `Artist/Album/Track`, and all playback/streaming
   is served from these paths. Hardlinks are instant and use no extra disk
   space. If the two paths are on different filesystems (where hardlinks are
   impossible), Musicarr falls back to copying.

For hardlinks to work, keep the slskd download directory and the root folder
on the same volume — e.g. one shared volume mounted at `/data` in both
containers, with slskd downloads in `/data/slskd/downloads` and the library
in `/data/media/music`.

`DATA_DIR` holds the SQLite database and must persist.

## Configuration from the UI

Most settings can be changed from the UI (admin only, under **Settings**),
like Radarr/Sonarr — no restart required, and values persist in the database:

- **Media management** — library root folder
- **Soulseek (slskd)** — URL, API key, and download directory (with a *Test
  connection* button and an enabled/off indicator)

Anything set in the UI is stored in the database and **takes precedence over the
corresponding environment variable**, which only seeds the first-run default. So
you can run with no slskd env vars at all and configure everything from the
Settings page after first login.

Each user can change their own password under **Profile**. There's a functional
graphic **equalizer** (player-bar popover and a dedicated **Equalizer** page so
it works even when nothing is playing; Web Audio, with presets), a **play queue**
(reorder, remove, jump; clicking a playlist track shuffles the whole playlist
into the queue), recent **search history** on the Search page, and the volume is
remembered across reboots.

**Deezer playlists**: the Home page suggests trending Deezer playlists. Adding
one creates a local playlist with the same tracks and queues a Soulseek
download for each track that isn't on disk yet (capped per run — re-add the
playlist to continue). Re-adding also refreshes the track list.

## Environment variables

All of these are optional seeds for the first-run defaults; the ones marked
*(UI)* can also be managed from the Settings page afterwards.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8686` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database location (persist this) |
| `MUSIC_DIR` | `/music` | Default root folder for the audio library *(UI)* |
| `SLSKD_URL` | — | slskd base URL, e.g. `http://slskd:5030` *(UI)* |
| `SLSKD_API_KEY` | — | slskd API key *(UI)* |
| `SLSKD_DOWNLOAD_DIR` | `/slskd-downloads` | Where slskd writes completed files, as Musicarr sees it (shared volume) *(UI)* |
| `ADMIN_USERNAME` | `admin` | Created on first boot only |
| `ADMIN_PASSWORD` | *(random)* | First-boot admin password seed. If unset, a strong random one is generated and printed to the logs; you must change it on first sign-in |
| `POLL_INTERVAL_MS` | `10000` | How often download progress is polled |
| `SWEEP_INTERVAL_MS` | `600000` | How often completed-but-unimported downloads are retried |
| `SLSKD_STALL_MS` | `900000` | A transfer with no progress for this long fails over to the next candidate |
| `BACKUP_ENABLED` | `true` | Nightly SQLite backups into `$DATA_DIR/backups`. Set `false` to disable |
| `BACKUP_RETENTION` | `7` | How many daily database backups to keep |
| `RELEASE_WATCH_ENABLED` | `true` | Auto-download new releases from followed artists. `false` to disable |
| `RELEASE_CHECK_INTERVAL_MS` | `21600000` | How often (ms) to check followed artists for new releases (default 6h) |
| `RELEASE_TYPES` | `album,ep,single` | Which Deezer record types to auto-download (`compilation` excluded by default) |
| `COOKIE_SECURE` | `true` | Mark the session cookie `Secure` and send HSTS. Set `false` for plain-HTTP/LAN |
| `TRUST_PROXY` | `1` | Proxy hop count for real client IP (login rate limiting) |

## API access tokens

For programmatic access — scripts, automations, or tools like **Claude Code** —
Musicarr issues **personal access tokens** so external services can call the API
without a browser session.

Create one under **Profile → API access tokens**. The token is shown **once** at
creation (store it somewhere safe); only a SHA-256 hash is kept in the database.
A token carries the **same permissions as the account that created it**, so a
token owned by an admin can reach admin-only endpoints.

Send it on each request as either header:

```bash
# Authorization: Bearer
curl -H "Authorization: Bearer mcr_xxxx…" http://localhost:8686/api/library

# or X-Api-Key
curl -H "X-Api-Key: mcr_xxxx…" http://localhost:8686/api/library
```

Every `/api/*` endpoint the UI uses is reachable this way — e.g. `GET
/api/search?q=…`, `POST /api/download`, `GET /api/downloads`, `GET
/api/playlists`. Revoke a token at any time from the same screen; revocation
takes effect immediately. As a safety measure, tokens can't create or revoke
other tokens — that requires an interactive sign-in.

## Made for you (mixes & smart playlists)

The **Made for you** page (and a row on Home) gathers auto-generated, ready-to-play
collections, refreshed from your activity:

- **Smart playlists** built straight from your own library and history —
  *On Repeat* (your most-played), *Recently Added*, and a *Liked Songs Mix*.
  These are immediately playable from disk.
- **Daily mixes** — discovery mixes seeded from your top artists, pulling in
  Deezer related-artist tracks. Anything not on disk yet downloads on tap.

## Your stats

A personal, Spotify-Wrapped-style dashboard under **Your stats**: tracks played,
time listened, unique artists/tracks, your top artists/tracks/albums and a
14-day activity chart. Toggle the window between this week, month, year, or all
time. Computed entirely from your own listening history.

## Listen Together

Play music in perfect-ish sync with other people on your server. Open the
**Listen together** control in the player bar and **Start a session** — you become
the host and your playback (current track, position, play/pause) drives everyone
else. Share the short **code**; others **Join** and follow along, with the client
correcting drift every couple of seconds. The host controls playback; guests
stream the same shared-library files. Leaving as the host ends the session.

## Install (PWA) & media keys

Musicarr can be installed as a progressive web app — add it to your home screen /
desktop for a standalone window — and integrates with the OS **Media Session API**
for lock-screen and media-key controls (play/pause, next/prev, seek) plus a synced
scrubber. There is intentionally **no offline mode**: Musicarr is a networked server,
so there's nothing to do when it can't be reached.

## Profiles & social

Each user has a profile with their recently played, liked songs and playlists.
Set a **profile picture** under **Profile** (it's downscaled in the browser and
shown in the sidebar, friend activity and on profiles). **Right-click** anyone in
the friend-activity panel or a user list to quickly **view their profile** or
**follow / unfollow** them.

Because the audio library is shared, a track another user has played is already
on the server. If it isn't in your **Library** view yet, an **add-to-library**
button (and right-click action) on their profile promotes it into the library in
one click — no re-download.

## Shared playlists

Playlists are private by default, but the owner can **share** one with other users
on the server. Open a playlist you own, hit **Share**, and search for a user:

- **Share** — read-only: the playlist appears in their library and they can play it.
- **Share & allow edits** — collaborative: they can also add and remove tracks.

Shared playlists show up in the recipient's sidebar labelled with the owner's name.
Recipients can "remove" a shared playlist to drop it from their own library without
affecting the original. Only the owner can manage who it's shared with or delete it
outright.

## Health checks

Three unauthenticated probe endpoints, suitable for Docker/Kubernetes:

- `GET /health` and `GET /health/live` — **liveness**: the process is up. Never
  touches the DB or slskd, so a slow dependency can't trigger a restart loop.
- `GET /health/ready` — **readiness**: returns `200` only when SQLite is
  reachable (and reports whether slskd is configured); `503` otherwise.
- `GET /healthz` — legacy alias of the liveness check.

## Backups

The database (users, playlists, favorites, listening history, API tokens) is the
only non-reproducible state — audio files can be re-downloaded. Musicarr writes a
nightly online backup to `$DATA_DIR/backups/musicarr-YYYY-MM-DD.db` using
SQLite's safe live-backup, keeping the most recent `BACKUP_RETENTION` (default 7).
Disable with `BACKUP_ENABLED=false`.

## Ports

- **8686** — HTTP (UI + API + audio streaming). Put it behind your own
  ingress/TLS.

