# Testing & coverage

The server has a comprehensive automated test suite built on Node's **built-in
test runner** (`node:test`) and **built-in coverage** — no third-party test or
coverage dependencies, matching the project's minimal-dependency philosophy.

## Running

```bash
npm test         # run the suite
npm run coverage # run with the enforced coverage gate (what CI runs)
```

CI (`.github/workflows/test.yml`) runs `npm run coverage` on every push and PR
and **fails the build** if coverage drops below the thresholds.

## Coverage gate

`npm run coverage` enforces:

| Metric | Threshold | Achieved |
|---|---|---|
| Lines | 99% | ~99.5% |
| Functions | 90% | ~91% |
| Branches | 78% | ~80% |

Per-module line coverage is **100%** for `cache`, `log`, `db`, `social`,
`listen`, `releases`, `backup`, and `sources`, and 98–99.7% for `api`,
`auth`, and `downloader`.

### Why not a literal 100%

The handful of uncovered lines are deliberately left, because covering them
would require either brittle tests or removing legitimate defensive code:

- **Unreachable defensive `catch` blocks** — e.g. `api.js` 502/500 handlers
  whose `try` bodies already catch every awaited call individually, so the
  outer handler can only fire on an impossible error.
- **Time-based reconnect logic** — `downloader.js` `ensureSlskdReady` retries
  on 3-second / 30-second timers; exercising the retry-then-give-up path would
  add tens of seconds of real waiting per run.
- **A 5000-entry memory-bound prune** in the login rate limiter, which would
  need 5000+ bcrypt-bearing login requests to trigger.
- **ISRC-tag matching** in the importer, which needs audio files carrying real
  ISRC metadata tags (the tests use generated WAVs, which carry duration but
  not ISRC).

`server/index.js` (the process bootstrap that binds the port and starts the
background pollers) is excluded from coverage: it is composition/wiring that is
exercised by actually running the app, and importing it in a unit test would
bind a socket and leak timers. Every module it wires up is covered directly.

## How it works

- Each test file runs in its own process (the runner's default isolation), so
  each gets a fresh temporary `DATA_DIR` and its own SQLite database. The
  `server/test/helpers/env.js` side-effect module sets those env vars **before**
  `db.js` is imported.
- External HTTP (Deezer, slskd, LRCLIB, preview CDNs) is stubbed with a small
  global-`fetch` mock (`helpers/fetchmock.js`). The real `fetch` is captured
  first so the HTTP test client can still reach the app under test.
- Express routes are tested over real HTTP against an ephemeral-port server
  (`helpers/app.js`), with auth either injected (`makeAuthedApp`) or driven
  through the real cookie/token stack (`makeRealAuthApp`).
- The downloader's import flow is driven end-to-end: a download row plus
  `resumeOnBoot` rebuilds the plan from (mocked) Deezer, and the captured poll
  `tick` imports generated WAV files from a fake slskd download directory.
