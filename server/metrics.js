// Prometheus metrics.
//
// Musicarr's failure modes are almost all invisible from the UI: Deezer rate
// limiting a fan-out page, slskd losing its Soulseek connection, a stream of
// downloads quietly ending in not_found. This exposes them as a scrape target so
// they show up on a dashboard and can page you, instead of being something you
// notice a week later because an album never arrived.
//
// Deliberately dependency-free: the exposition format is a few lines of text,
// and a metrics client is not worth pulling into an app whose whole runtime is
// four packages.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, config } from './db.js';
import { logger } from './log.js';

const log = logger('metrics');
const startedAt = Date.now();

// Scraping is on by default (the endpoint only reports aggregates — no
// usernames, titles or paths). Set METRICS_ENABLED=false to remove it entirely,
// or METRICS_TOKEN to require a bearer token when the port is reachable beyond
// your monitoring network.
export const metricsEnabled = () => process.env.METRICS_ENABLED !== 'false';
const metricsToken = () => process.env.METRICS_TOKEN || '';

/* ------------------------------------------------------------- counters */
// name -> Map of serialized-labels -> { labels, value }. Process-lifetime
// counters, reset on restart, which is exactly what Prometheus expects (it
// detects the reset and accounts for it).
const counters = new Map();

const labelKey = (labels) => Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join(',');

/** Bump a counter. Cheap enough to call on every external request. */
export function inc(name, labels = {}, n = 1) {
  if (!counters.has(name)) counters.set(name, new Map());
  const series = counters.get(name);
  const key = labelKey(labels);
  const cur = series.get(key);
  if (cur) cur.value += n;
  else series.set(key, { labels, value: n });
}

/** Test seam: drop every counter so one test's numbers don't leak into the next. */
export function resetCounters() { counters.clear(); }

/* ------------------------------------------------------------ rendering */
// Label values are quoted in the exposition format, so backslashes, quotes and
// newlines have to be escaped or the scrape fails to parse.
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelsOf = (labels) => {
  const pairs = Object.entries(labels).filter(([, v]) => v !== null && v !== undefined);
  return pairs.length ? `{${pairs.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
};

// The app version, for a build_info series. Read once, best-effort.
const version = (() => {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
})();

const num = (sql) => Number(db.prepare(sql).get()?.n ?? 0);

// Help text for the counters other modules bump, kept here so the exposition
// stays self-describing without every call site repeating it.
const COUNTER_HELP = {
  musicarr_external_requests_total: 'Outbound requests to an external service, by outcome.',
  musicarr_download_transitions_total: 'Download status transitions since boot.',
  musicarr_imports_total: 'Files imported into the library, by result.',
  musicarr_http_requests_total: 'HTTP requests served, by method and status (probes and scrapes excluded).',
  musicarr_upgrades_total: 'Quality upgrades queued, by the format being replaced.',
};

/** Render the current metrics in the Prometheus text exposition format. */
export function metricsText() {
  const out = [];
  const emit = (name, type, help, samples) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) out.push(`${name}${labelsOf(labels)} ${value}`);
  };

  emit('musicarr_build_info', 'gauge', 'Build metadata; always 1.', [[{ version }, 1]]);
  emit('musicarr_uptime_seconds', 'gauge', 'Seconds since this process started.',
    [[{}, Math.floor((Date.now() - startedAt) / 1000)]]);

  // --- Library ---
  emit('musicarr_tracks_total', 'gauge', 'Tracks known to the catalog (downloaded or not).',
    [[{}, num('SELECT COUNT(*) AS n FROM tracks')]]);
  emit('musicarr_tracks_on_disk', 'gauge', 'Tracks whose audio file is in the library.',
    [[{}, num('SELECT COUNT(*) AS n FROM tracks WHERE file_path IS NOT NULL')]]);
  emit('musicarr_albums_on_disk', 'gauge', 'Distinct albums with at least one file in the library.',
    [[{}, num('SELECT COUNT(DISTINCT album_id) AS n FROM tracks WHERE file_path IS NOT NULL AND album_id IS NOT NULL')]]);

  // --- Users and activity ---
  emit('musicarr_users_total', 'gauge', 'User accounts.', [[{}, num('SELECT COUNT(*) AS n FROM users')]]);
  emit('musicarr_playlists_total', 'gauge', 'Playlists across all users.',
    [[{}, num('SELECT COUNT(*) AS n FROM playlists')]]);
  emit('musicarr_plays_total', 'gauge', 'Recorded plays across all users.',
    [[{}, num('SELECT COUNT(*) AS n FROM plays')]]);
  emit('musicarr_followed_artists_total', 'gauge', 'Artist follows driving the new-release watcher.',
    [[{}, num('SELECT COUNT(*) AS n FROM followed_artists')]]);

  // --- Downloads: the queue right now, by status. `searching`/`downloading`
  // stuck high, or a rising `not_found`, is the signal worth alerting on.
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM downloads GROUP BY status').all();
  emit('musicarr_downloads', 'gauge', 'Download rows by current status.',
    byStatus.length ? byStatus.map(r => [{ status: r.status }, r.n]) : [[{ status: 'none' }, 0]]);

  // --- Dependencies ---
  emit('musicarr_slskd_configured', 'gauge', 'Whether a slskd URL and API key are set.',
    [[{}, config.slskdEnabled ? 1 : 0]]);

  // --- Process ---
  const mem = process.memoryUsage();
  emit('musicarr_process_resident_memory_bytes', 'gauge', 'Resident set size.', [[{}, mem.rss]]);
  emit('musicarr_nodejs_heap_used_bytes', 'gauge', 'V8 heap in use.', [[{}, mem.heapUsed]]);

  // --- Counters accumulated since boot ---
  for (const [name, series] of counters) {
    emit(name, 'counter', COUNTER_HELP[name] || 'Musicarr counter.',
      [...series.values()].map(s => [s.labels, s.value]));
  }

  return out.join('\n') + '\n';
}

/* --------------------------------------------------------------- routing */
/** Constant-time bearer check, so a wrong token can't be narrowed by timing. */
function tokenOk(req) {
  const want = metricsToken();
  if (!want) return true;
  const auth = req.headers.authorization || '';
  const got = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || req.headers['x-api-key'] || '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Mount GET /metrics. Registered next to the health probes in index.js —
 *  before auth, since a scraper has no session. */
export function registerMetrics(app) {
  app.get('/metrics', (req, res) => {
    if (!metricsEnabled()) return res.status(404).json({ error: 'Metrics are disabled' });
    if (!tokenOk(req)) return res.status(401).json({ error: 'Invalid metrics token' });
    try {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(metricsText());
    } catch (e) {
      // A scrape must never take the process down with it.
      log.warn(`metrics collection failed: ${e.message}`);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
}
