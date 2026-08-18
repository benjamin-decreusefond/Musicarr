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
7. Optionally, the file's tags are rewritten from the Deezer metadata first, so
   the library also reads correctly outside Musicarr — see [File tags](#file-tags).

Library search runs against a SQLite **FTS5** index kept in sync by triggers, so
searching stays fast as the catalog grows; a query the index can't answer (a
mid-word fragment) falls back to a substring scan. Long track lists are
**windowed** in the browser — only the rows on screen are mounted — so a library
of tens of thousands of tracks opens and scrolls like a small one.

Streaming serves byte ranges so seeking is instant. Optional **transcoding**
(`?fmt=opus|mp3`, admin-enabled, needs ffmpeg) is seekable too: the output is
constant-bitrate, so its total size is predicted from the track's duration,
advertised as a `Content-Length`, and a `Range` request restarts ffmpeg at the
matching timestamp — which is what lets the scrubber move on a phone instead of
only within what has buffered.

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
- **Soulseek (slskd)** — URL, API key, and download directory, with a *Test
  connection* button and an enabled/off indicator
- **Quality profile** — which formats to accept and in what order, a minimum
  bitrate, and the format worth upgrading towards. See
  [Quality profile & upgrades](#quality-profile--upgrades)
- **File metadata** — rewrite tags on import and look tracks up in MusicBrainz.
  See [File tags](#file-tags)
- **Library maintenance** — automatic removal of unplayed tracks

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
| `AUTH_METHOD` | `login` | How requests are authenticated: `login` (built-in username/password), `none` (no auth — every request is a single admin user), or `proxy` (trust an authenticating reverse proxy). See [Authentication method](#authentication-method) |
| `AUTH_PROXY_HEADER` | `x-forwarded-user` | *(proxy)* Request header the proxy sets to the authenticated username |
| `AUTH_PROXY_ADMIN_USERS` | — | *(proxy)* Comma-separated usernames that are always admins |
| `AUTH_PROXY_TRUSTED_IPS` | — | *(proxy)* Comma-separated IPs; the identity header is only honoured when the connection comes from one of them. Empty trusts any source (the app must then be reachable only through the proxy) |
| `AUTH_PROXY_LOGOUT_URL` | — | *(proxy)* URL the web UI's "sign out" button points at (your proxy's sign-out endpoint, e.g. `/oauth2/sign_out`) |
| `METRICS_ENABLED` | `true` | Serve the Prometheus scrape endpoint at `/metrics`. Set `false` to remove it |
| `METRICS_TOKEN` | — | When set, `/metrics` requires this token as `Authorization: Bearer` or `X-Api-Key` |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary used for transcoding and tag writing |
| `LOG_FORMAT` | `text` | `json` emits one JSON object per line for a log pipeline |
| `UPGRADE_INTERVAL_MS` | `21600000` | How often the quality-upgrade sweep runs (default 6h) |
| `UPGRADE_BATCH_SIZE` | `10` | How many upgrades one sweep may queue |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org` | MusicBrainz web service (point at a mirror if you run one) |
| `MUSICBRAINZ_INTERVAL_MS` | `1000` | Minimum gap between MusicBrainz requests. Their terms say one per second |
| `COVERART_URL` | `https://coverartarchive.org` | Cover Art Archive base, for MusicBrainz-sourced covers |

## Authentication method

Musicarr can authenticate requests in three ways, chosen at boot with the
`AUTH_METHOD` environment variable:

- **`login`** *(default)* — the built-in username/password sign-in. Sessions are
  cookie-based; the first-boot admin is created as described above.
- **`none`** — no authentication at all. Every request acts as a single shared
  admin user, so there is no sign-in screen. Only use this on a **trusted,
  isolated network** (e.g. behind your own VPN), never on the open internet.
- **`proxy`** — trust an authenticating reverse proxy in front of Musicarr
  ([oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/),
  [Authelia](https://www.authelia.com/),
  [Authentik](https://goauthentik.io/), Cloudflare Access, …). The proxy signs
  the user in and forwards their identity in a header; Musicarr reads that header,
  auto-provisions the user on first sight, and treats them as signed in. This is
  how you put OAuth/OIDC/SAML/SSO in front of Musicarr.

### Putting OAuth in front (proxy mode)

Set `AUTH_METHOD=proxy` and point `AUTH_PROXY_HEADER` at whatever username header
your proxy emits (oauth2-proxy uses `X-Forwarded-User`; Authelia/Authentik use
`Remote-User`). The **first** user seen becomes an admin so the instance is
manageable; grant admin to specific accounts with `AUTH_PROXY_ADMIN_USERS`.

> **Security:** a trusted header is only as safe as your network. Anyone who can
> reach Musicarr directly could otherwise send the header themselves. Either make
> sure the container is reachable *only* through the proxy, or list the proxy's
> address(es) in `AUTH_PROXY_TRUSTED_IPS` — the header is then honoured only when
> the connection actually comes from the proxy (checked against the real socket
> address, not the spoofable `X-Forwarded-For`). Also configure your proxy to
> **strip** the identity header from inbound client requests.

### Desktop / API clients in `none` and `proxy` modes

Browsers go through the proxy, but a desktop or mobile client (or a script) often
connects to Musicarr **directly**, without doing a browser OAuth dance. Those
clients keep working:

- **Native login and sessions still work** in `proxy` mode — a client that has a
  Musicarr password can `POST /api/auth/login` and use the session cookie.
- **Set a client password even for SSO users.** Users provisioned by the proxy
  have no native password, but they can set one for direct client login under
  **Profile → Client login password** (no current password needed — the proxy
  already authenticated them). The client then signs in with the username +
  that password.
- **[API access tokens](#api-access-tokens) work in every mode.** Sign in through
  the proxy in your browser, create a token under **Profile → API access tokens**,
  and use it from the client as an `Authorization: Bearer` (or `X-Api-Key`)
  header. A client's own credentials always take precedence over the proxy header.

Recommended flow: **OAuth for the web UI; a client password or a personal access
token for your desktop/mobile clients.**

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

## Track previews

Songs that aren't downloaded yet can be **previewed** — a 30-second clip from
Deezer — before committing to a Soulseek download. Hit the headphones button on
any not-downloaded track (or use the right-click menu). Previews are proxied
through the server (`GET /api/preview/:trackId`) so they play same-origin under
the CSP and Deezer's signed preview URLs never reach the browser; playing a real
track or pressing play stops the preview.

## Quality profile & upgrades

Soulseek hands you whatever the first willing peer happened to have. Without a
policy, a library slowly fills with 192kbps rips of albums that are widely shared
in FLAC, and the only fix was deleting tracks and re-requesting them by hand.

**Settings → Quality profile** separates the two questions that actually matter:

- **Accepted formats, best first.** Only these are ever downloaded, and the
  *order is the preference* — put MP3 first and a phone-friendly library is what
  you get, rather than FLACs you then have to convert. Ranking follows the
  ordering; bitrate only separates two files of the same format.
- **Minimum bitrate.** Lossy candidates below it are refused outright — a 96kbps
  rip that matches the title perfectly is worse than no file at all. Lossless is
  never measured against it, and a candidate whose bitrate Soulseek doesn't
  report is kept (it often omits it, and the title/duration gates are the real
  filter).
- **Upgrade target.** The quality worth *replacing an existing file* for. Empty
  (the default) means nothing is ever upgraded.

With a target set, **Automatically look for better copies** runs a sweep every
few hours over a small batch (`UPGRADE_BATCH_SIZE`, default 10):

1. Library files below the target are found from the format and bitrate recorded
   at import — no reopening thousands of files on every pass.
2. Each is searched for **in the target format only**, so anything that comes
   back is an improvement by construction and never has to be second-guessed.
3. On import the new file replaces the old one, which is deleted along with its
   source copy.
4. A track nobody shares in that format is stamped as checked and left alone for
   a month, instead of being re-searched every six hours forever.

Lossless is treated as the ceiling: with FLAC as the target a lossless file is
done, and with a lossy target a lossless file is **never** downgraded to reach
it — a target is a floor to reach, not a format to force every file into.

There's a **Look for upgrades now** button next to the setting for a one-off run.

Files imported before this existed have their format and bitrate filled in by
the sweep, a couple of hundred at a time.

## File tags

Musicarr reads every title, artist and album from its own database, so it plays
a library correctly no matter what the files themselves say. **Other players
don't.** Soulseek files arrive with whatever tags the sharing peer had — often a
`Track 03` title, a transliterated artist, no album art, sometimes nothing at
all — so the same library opened in Jellyfin, on a phone or in a car can be a
mess.

Turn on **Settings → File metadata → Write tags on imported files** and every
imported file is stamped with the metadata Musicarr asked for: title, artist,
album, album artist, track number (`3/12`), disc number, ISRC, and the album
cover embedded at 1000px. The audio itself is never re-encoded — ffmpeg copies
the bitstream and only rebuilds the metadata container — so a FLAC stays exactly
the FLAC the peer shared.

- **Requires ffmpeg** on the server. It ships in the Docker image; set
  `FFMPEG_PATH` if yours lives somewhere unusual.
- **Off by default**, because it rewrites files you received from other people.
- **Only new imports.** Files already in the library are left alone; re-download
  a track to retag it.
- **Best-effort.** If ffmpeg fails, the import still completes with the original
  file — you get an untagged track, never a lost one. If only the cover art is
  the problem, it retries once without it and keeps the tags.
- **Album art costs one image download per album** and can be turned off
  separately.
- Formats: MP3, FLAC, M4A/MP4, Ogg and Opus are tagged (Ogg/Opus without
  embedded art). Anything else is imported untouched.

Tagging happens **before** the file is hardlinked into the library, while it is
still a single inode shared with slskd's download directory. That keeps the "a
file is only ever stored once" property intact — tagging after the link would
leave you with two full copies of every song.

## MusicBrainz

Deezer is Musicarr's catalog and stays that way — `deezer_id` is what every
playlist, favorite and download row points at. What MusicBrainz adds is the
**identity layer Deezer doesn't have**: stable MBIDs for the recording, release
and artist, plus the original release date rather than the pressing Deezer
happens to serve.

That matters outside Musicarr. MBIDs are what **Picard, Jellyfin, Plex and Beets**
key on: a library tagged with them is one those tools recognise outright instead
of re-guessing what each file is.

Enable it under **Settings → File metadata → Look imports up in MusicBrainz**.
Each imported track is matched:

1. **By ISRC** where Deezer provides one — an ISRC identifies one specific
   recording, so this is a lookup, not a fuzzy match.
2. **By a search** otherwise, accepted only on a high score *and* a length that
   agrees within five seconds. A wrong MBID is worse than none, because it's the
   identifier other tools will then trust.

The MBIDs and date are stored on the track and written into the file when tag
writing is on. MusicBrainz is donation-funded and caps anonymous clients at one
request per second; Musicarr honours that by serializing every call through a
rate limiter, so album imports take a little longer. Results are cached for a
day, and an outage costs metadata, never an import.

## When Deezer doesn't have it

Deezer's catalog has gaps — independent labels, recent releases, regional
pressings. Turn on **Settings → File metadata → Search MusicBrainz when Deezer
finds nothing** and a search that returns *no* Deezer result at all is looked up
in MusicBrainz instead; those releases can then be downloaded like any other.

This works because the download path never really needed Deezer. Soulseek is
searched with an artist, a title and a duration, and matched against a
tracklist — MusicBrainz has all of them. The one thing Deezer uniquely provided
was the integer key every playlist, favorite and download row points at, so
MusicBrainz rows are given a synthetic id above a reserved base and mapped to
their MBID. Deezer ids are ten digits; the base is 10¹², so the two can never
collide, and ids are never reused even after a row is deleted.

**Only on a completely empty result.** A partial Deezer result means Deezer is
ranking badly, not that the release is missing, and mixing catalogs there would
scatter non-Deezer rows through everyday searches.

What differs for a MusicBrainz release:

- **Covers still work** — they come from the [Cover Art
  Archive](https://coverartarchive.org), keyed by release. A release with no
  artwork shows a blank cover.
- **No 30-second preview.** Previews are Deezer's clips; MusicBrainz stores no
  audio, so the button isn't shown (and the API says so plainly).
- **No artist page.** MusicBrainz has no "top tracks" or "related artists", so
  these tracks show the artist as plain text rather than a link.
- **Not in Explore, Made for you, or the release watcher**, which are all built
  on Deezer's recommendations.

Everything else is identical: ranking, the quality profile, matching, import,
tagging and the library.

## Metrics

Musicarr exposes Prometheus metrics at **`GET /metrics`**, so the things that
fail silently — Deezer rate-limiting a page, slskd losing its Soulseek
connection, a run of downloads quietly ending in `not_found` — show up on a
dashboard instead of a week later when an album never arrived.

```bash
curl http://localhost:8686/metrics
```

| Metric | Type | What it tells you |
|---|---|---|
| `musicarr_tracks_total`, `musicarr_tracks_on_disk`, `musicarr_albums_on_disk` | gauge | Library size, and how much of the catalog is actually downloaded |
| `musicarr_downloads{status}` | gauge | The queue right now. A rising `not_found`, or `searching` stuck high, is the alert worth having |
| `musicarr_download_transitions_total{status}` | counter | Throughput and failure rate over time |
| `musicarr_imports_total{result}` | counter | `imported` vs `unmatched` — match quality, before anyone complains |
| `musicarr_external_requests_total{service,outcome}` | counter | Deezer and slskd call volume and errors |
| `musicarr_slskd_configured` | gauge | Whether the download engine is set up at all |
| `musicarr_users_total`, `musicarr_plays_total`, `musicarr_playlists_total`, `musicarr_followed_artists_total` | gauge | Usage |
| `musicarr_uptime_seconds`, `musicarr_process_resident_memory_bytes`, `musicarr_nodejs_heap_used_bytes` | gauge | Process health |

The endpoint reports **aggregates only** — no usernames, track titles or file
paths — and is unauthenticated by default so a scraper needs no session, like
the health probes. Set `METRICS_TOKEN` to require a bearer token if the port is
reachable beyond your monitoring network, or `METRICS_ENABLED=false` to remove
the endpoint entirely.

With kube-prometheus-stack, a `ServiceMonitor` on the `http` port with
`path: /metrics` is all it takes.

## Logs

`LOG_LEVEL` (`error|warn|info|debug`) sets verbosity. `LOG_FORMAT=json` switches
every record to one JSON object per line, which is what a pipeline (Loki,
Elasticsearch, CloudWatch) needs to index fields instead of regex-scraping a
sentence:

```json
{"ts":"2026-08-18T11:20:03.412Z","level":"info","scope":"download","requestId":"a3f19c02","msg":"#42 imported \"Artist - Song\""}
```

Every record produced while handling a request carries that request's
**`requestId`**, so the twenty lines a failed album download writes across four
modules can be pulled up as one story. The id is returned on the response as
`X-Request-Id`, and an inbound `X-Request-Id` from your proxy is honoured (when
it looks like an id — arbitrary text could forge log records). Background jobs
get their own id, e.g. `upgrade-sweep`.

The text format stays the default so `docker logs` on a laptop is still readable.

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

## Testing

The server ships with a comprehensive test suite (Node's built-in test runner,
no extra dependencies) and a CI-enforced coverage gate (~99.5% lines):

```bash
npm test         # run the suite
npm run coverage # run with the coverage gate (what CI enforces)
```

See [TESTING.md](TESTING.md) for details.

