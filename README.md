# Tonearr

A self-hosted, Spotify-style music app that browses metadata from **Deezer**
(free, no API key), finds releases through **Jackett**, and downloads them with
**Transmission**. Per-user playlists, favorites, and accounts; a single shared
audio library on disk with file deduplication; built-in streaming with HTTP
range support. State lives in **SQLite** — no Postgres required.

It does *not* use Lidarr: Lidarr's artist/album model makes single-track
downloads awkward, so Tonearr talks to Jackett directly and decides per-request
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
docker build -t tonearr:latest .
```

The build is multi-stage: it bundles the React frontend, compiles
`better-sqlite3`, and produces a runtime image that runs as the non-root `node`
user and exposes **port 8686**.

## Run

```bash
docker run -d --name tonearr -p 8686:8686 \
  -e JACKETT_URL=http://jackett:9117 \
  -e JACKETT_API_KEY=your_jackett_api_key \
  -e TRANSMISSION_URL=http://transmission:9091/transmission/rpc \
  -e ADMIN_PASSWORD=change-me \
  -v tonearr-data:/data \
  -v /path/to/music:/music \
  -v /path/to/downloads:/downloads \
  tonearr:latest
```

### The shared-download-path requirement

Tonearr and Transmission must agree on where downloads land. Tonearr reads the
finished files from `DOWNLOAD_DIR`; it tells Transmission to save them under
`TRANSMISSION_DOWNLOAD_DIR`. **Mount the same physical volume at the same path
in both containers** (e.g. `/downloads`) and you can leave
`TRANSMISSION_DOWNLOAD_DIR` unset (it defaults to `DOWNLOAD_DIR`). If the paths
differ between the two, set both variables so the mapping is correct.

`/music` is where the permanent library lives and should be a persistent
volume. `/data` holds the SQLite database and must also persist.

The library root folder can also be changed from the UI (admin only, under
**Settings → Media management**), like Radarr/Sonarr root folders. A value set
there is stored in the database and takes precedence over `MUSIC_DIR`, which
only provides the initial default.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8686` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database location (persist this) |
| `MUSIC_DIR` | `/music` | Default root folder for the audio library (persist this) |
| `DOWNLOAD_DIR` | `/downloads` | Where Tonearr reads completed downloads |
| `TRANSMISSION_DOWNLOAD_DIR` | = `DOWNLOAD_DIR` | Download path as Transmission sees it |
| `JACKETT_URL` | — | e.g. `http://jackett:9117` (no trailing slash) |
| `JACKETT_API_KEY` | — | From Jackett's dashboard |
| `JACKETT_INDEXER` | `all` | Indexer id, or `all` to query every configured one |
| `SEARCH_CATEGORIES` | `3000` | Torznab categories (3000 = Audio); comma-separated |
| `TRANSMISSION_URL` | `http://transmission:9091/transmission/rpc` | RPC endpoint |
| `TRANSMISSION_USER` | — | RPC username (if auth enabled) |
| `TRANSMISSION_PASS` | — | RPC password |
| `ADMIN_USERNAME` | `admin` | Created on first boot only |
| `ADMIN_PASSWORD` | `admin` | **Change this.** Created on first boot only |
| `POLL_INTERVAL_MS` | `10000` | How often download progress is polled |

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
- The Transmission client must allow RPC access from the Tonearr container
  (`rpc-whitelist` / `rpc-host-whitelist`).
