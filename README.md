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

## CI / publishing the image

A GitHub Actions workflow (`.github/workflows/docker.yml`) builds and pushes the
image to Docker Hub as `paganim/musicarr:latest` (plus a commit-SHA tag) on every
push to the default branch. It needs two repository secrets:

- `DOCKERHUB_USERNAME` — the Docker Hub account (e.g. `paganim`)
- `DOCKERHUB_TOKEN` — a Docker Hub access token with write scope

## Caching

Responses from Deezer are cached in memory for 5 minutes to avoid rate limits,
with concurrent identical requests de-duplicated into a single upstream call.

## Soulseek (slskd) setup

slskd is both the search engine and the download client: it connects to the
Soulseek network with an account you choose, and Musicarr drives it over its
REST API. Two directory points to get right:

1. **Download directory** — slskd writes completed files to its own downloads
   folder; Musicarr imports from there (then hardlinks into the root folder).
   Mount slskd's downloads volume so Musicarr can read it, and set **slskd
   download directory** to that path.
2. **Sharing back** — Soulseek is a give-and-take community; peers commonly ban
   users who share nothing. Point slskd's shares at your music root folder so
   you contribute back. This is slskd-side config, e.g.:

```yaml
# slskd.yml (or equivalent env)
shares:
  directories:
    - /music            # your Musicarr root folder, mounted read-only into slskd
directories:
  downloads: /downloads # mount this same volume into Musicarr as SLSKD_DOWNLOAD_DIR
web:
  authentication:
    api_keys:
      musicarr:
        key: <the API key you put in Musicarr>  # 16-255 chars, you choose it
        role: readwrite
```

You'll need a Soulseek account (just a username/password you choose) configured
in slskd (`SLSKD_SLSK_USERNAME` / `SLSKD_SLSK_PASSWORD`).

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
| `ADMIN_PASSWORD` | `admin` | **Change this.** Created on first boot only |
| `POLL_INTERVAL_MS` | `10000` | How often download progress is polled |
| `SWEEP_INTERVAL_MS` | `600000` | How often completed-but-unimported downloads are retried |
| `SLSKD_STALL_MS` | `900000` | A transfer with no progress for this long fails over to the next candidate |

## First login

On first boot an admin account is created from `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. Sign in, then go to **Users** (admin only) to add more
accounts. Each user gets their own playlists and liked songs but shares the
downloaded audio library.

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

## Ports

- **8686** — HTTP (UI + API + audio streaming). Put it behind your own
  ingress/TLS.

## Notes & limits

- Authentication is cookie-session based (HttpOnly, SameSite=Lax) for the UI,
  with personal access tokens for programmatic API access (see **API access
  tokens**). Serve over HTTPS in production.
- Deezer is used purely for metadata and discovery; no audio comes from Deezer.
- Streaming reads files directly from `/music` with range requests, so seeking
  works in the browser for FLAC/MP3/M4A/OGG/Opus/WAV/AAC.
- Soulseek availability is peer-dependent: a file exists as long as a user who
  shares it is online. Failed transfers are retried against the next-best
  candidate on the next sweep.
