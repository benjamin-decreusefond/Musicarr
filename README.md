# Musicarr

A self-hosted, Spotify-style music app that browses metadata from **Deezer**
(free, no API key), finds releases through **Jackett**, and downloads them with
**Transmission**. Per-user playlists, favorites, and accounts; a single shared
audio library on disk with file deduplication; built-in streaming with HTTP
range support. State lives in **SQLite** — no Postgres required.

It does *not* use Lidarr: Lidarr's artist/album model makes single-track
downloads awkward, so Musicarr talks to Jackett directly and decides per-request
whether to grab a whole album or a single track.

## How it works

1. You search. The UI shows artists, albums and tracks from Deezer with art.
2. You hit **download** on an album or a single track.
3. The server queries Jackett (Torznab), scores the results (artist/title match,
   FLAC/320 bonus, seeders, discography penalty, dead-torrent rejection) and
   picks the best release.
4. It hands the magnet/torrent to Transmission into a per-request subfolder.
5. On completion, audio files are matched to the requested Deezer tracks (by
   track number, then fuzzy title) and copied into `/music/Artist/Album/`.
   For a single-track request that lands inside a full-album torrent, only the
   one matching file is imported.
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
  -e JACKETT_URL=http://jackett:9117 \
  -e JACKETT_API_KEY=your_jackett_api_key \
  -e TRANSMISSION_URL=http://transmission:9091/transmission/rpc \
  -e ADMIN_PASSWORD=change-me \
  -v musicarr-data:/data \
  -v /path/to/music:/music \
  -v /path/to/downloads:/downloads \
  musicarr:latest
```

### How downloads reach the library (Radarr/Sonarr model)

The flow is: **Transmission downloads → Musicarr hardlinks into the root
folder → the library streams from the root folder.**

Two paths, both configurable from **Settings → Media management**:

1. **Transmission download directory** — Musicarr tells Transmission to save
   each download here (under a `musicarr-<id>` subfolder). When the download
   finishes, Musicarr scans this folder once to import the files. **Mount the
   same physical volume at the same path in both containers** so they agree
   on it.
2. **Root folder** — the library. On import, Musicarr **hardlinks** the audio
   files here, organized as `Artist/Album/Track`, and all playback/streaming
   is served from these paths. Hardlinks are instant, use no extra disk
   space, and let the torrent keep seeding from the download directory. If
   the two paths are on different filesystems (where hardlinks are
   impossible), Musicarr falls back to copying.

For hardlinks to work, keep the download directory and the root folder on the
same volume — e.g. one shared volume mounted at `/data` in both containers,
with downloads in `/data/downloads/music` and the library in
`/data/media/music`.

`/data` (in the example above) should be a persistent volume; `DATA_DIR`
holds the SQLite database and must also persist.

## Configuration from the UI

Most settings can be changed from the UI (admin only, under **Settings**),
like Radarr/Sonarr — no restart required, and values persist in the database:

- **Media management** — library root folder and the Transmission download directory
- **Jackett** — URL, API key, indexer, and search categories (with a *Test connection* button)
- **Transmission** — RPC URL, username, and password (with a *Test connection* button)

Anything set in the UI is stored in the database and **takes precedence over the
corresponding environment variable**, which only seeds the first-run default. So
you can run with no Jackett/Transmission env vars at all and configure everything
from the Settings page after first login.

Each user can change their own password under **Profile** (click the username in
the sidebar). There's a functional graphic **equalizer** in the player bar
(Web Audio, with presets) and recent **search history** on the Search page.

## CI / publishing the image

A GitHub Actions workflow (`.github/workflows/docker.yml`) builds and pushes the
image to Docker Hub as `paganim/musicarr:latest` (plus a commit-SHA tag) on every
push to the default branch. It needs two repository secrets:

- `DOCKERHUB_USERNAME` — the Docker Hub account (e.g. `paganim`)
- `DOCKERHUB_TOKEN` — a Docker Hub access token with write scope

## Caching

Responses from the external APIs are cached in memory to avoid rate limits:
Deezer metadata for 5 minutes and Jackett searches for 10 minutes, with
concurrent identical requests de-duplicated into a single upstream call.

## Environment variables

All of these are optional seeds for the first-run defaults; the ones marked
*(UI)* can also be managed from the Settings page afterwards.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8686` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database location (persist this) |
| `MUSIC_DIR` | `/music` | Default root folder for the audio library *(UI)* |
| `TRANSMISSION_DOWNLOAD_DIR` | `/downloads` | Shared download path: Transmission writes here, Musicarr reads back from it *(UI)*. `DOWNLOAD_DIR` is accepted as a legacy alias. |
| `JACKETT_URL` | — | e.g. `http://jackett:9117` (no trailing slash) *(UI)* |
| `JACKETT_API_KEY` | — | From Jackett's dashboard *(UI)* |
| `JACKETT_INDEXER` | `all` | Indexer id, or `all` to query every configured one *(UI)* |
| `SEARCH_CATEGORIES` | `3000` | Torznab categories (3000 = Audio); comma-separated *(UI)* |
| `TRANSMISSION_URL` | `http://transmission:9091/transmission/rpc` | RPC endpoint *(UI)* |
| `TRANSMISSION_USER` | — | RPC username (if auth enabled) *(UI)* |
| `TRANSMISSION_PASS` | — | RPC password *(UI)* |
| `ADMIN_USERNAME` | `admin` | Created on first boot only |
| `ADMIN_PASSWORD` | `admin` | **Change this.** Created on first boot only |
| `POLL_INTERVAL_MS` | `10000` | How often download progress is polled |
| `SWEEP_INTERVAL_MS` | `600000` | How often the download dir is re-scanned for completed-but-unimported files |
| `JACKETT_TIMEOUT_MS` | `120000` | Search timeout; the `all` aggregate waits for the slowest indexer |

## First login

On first boot an admin account is created from `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. Sign in, then go to **Users** (admin only) to add more
accounts. Each user gets their own playlists and liked songs but shares the
downloaded audio library.

## Ports

- **8686** — HTTP (UI + API + audio streaming). Put it behind your own
  ingress/TLS.

## Notes & limits

- Authentication is cookie-session based (HttpOnly, SameSite=Lax). Serve over
  HTTPS in production.
- Deezer is used purely for metadata and discovery; no audio comes from Deezer.
- Streaming reads files directly from `/music` with range requests, so seeking
  works in the browser for FLAC/MP3/M4A/OGG/Opus/WAV/AAC.
- The Transmission client must allow RPC access from the Musicarr container
  (`rpc-whitelist` / `rpc-host-whitelist`).
