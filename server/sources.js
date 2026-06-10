import { Router } from 'express';
import { config } from './db.js';
import { logger } from './log.js';
import { createCache } from './cache.js';

const log = logger('sources');

/* ---------------------------------------------------------------- Deezer */
// Free, key-less metadata API. We proxy it server-side (no CORS issues, and
// responses get a short cache).
// Overridable for tests and proxied setups.
const DEEZER = (process.env.DEEZER_URL || 'https://api.deezer.com').replace(/\/$/, '');
const ALLOWED = [
  /^search(\/(track|album|artist))?$/,
  /^track\/\d+$/,
  /^album\/\d+(\/tracks)?$/,
  /^artist\/\d+(\/(top|albums|related|radio))?$/,
  /^chart(\/0\/(tracks|albums|artists))?$/,
  /^genre$/,
  /^editorial\/\d+\/charts$/,
];

const deezerCache = createCache({ ttlMs: 5 * 60 * 1000, max: 1000 });

export async function deezerGet(pathAndQuery) {
  const url = `${DEEZER}/${pathAndQuery}`;
  return deezerCache.wrap(url, async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Deezer ${r.status}`);
    const body = await r.json();
    // Deezer reports errors as 200s with an error payload; surface (and don't
    // cache) those rather than letting undefined fields through.
    if (body?.error) throw new Error(`Deezer: ${body.error.message || body.error.type || JSON.stringify(body.error)}`);
    return body;
  });
}

export const deezerRouter = Router();
deezerRouter.get(/^\/(.*)$/, async (req, res) => {
  const p = req.params[0];
  if (!ALLOWED.some(rx => rx.test(p))) return res.status(400).json({ error: 'Path not allowed' });
  const qs = new URLSearchParams(req.query).toString();
  try {
    res.json(await deezerGet(p + (qs ? `?${qs}` : '')));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* --------------------------------------------------------------- Jackett */
// Cache search results briefly: identical queries (e.g. retrying a download,
// or several users grabbing the same release) won't re-hit the trackers.
const jackettCache = createCache({ ttlMs: 10 * 60 * 1000, max: 300 });

// Searching the "all" aggregate fans out to every configured indexer and
// waits for the slowest one — that routinely takes 1-2 minutes, so the
// timeout must be generous ("Test connection" uses the instant caps endpoint,
// which is why it can say OK while a real search times out).
const JACKETT_TIMEOUT_MS = parseInt(process.env.JACKETT_TIMEOUT_MS || '120000', 10);

export async function jackettSearch(query) {
  if (!config.jackettUrl || !config.jackettApiKey) {
    log.warn('Jackett is not configured (URL / API key missing) — set it under Settings → Jackett');
    throw new Error('Jackett URL / API key not configured');
  }
  const params = new URLSearchParams({ apikey: config.jackettApiKey, Query: query });
  for (const c of config.searchCategories) params.append('Category[]', c);
  const url = `${config.jackettUrl}/api/v2.0/indexers/${config.jackettIndexer}/results?${params}`;
  // Key on everything that changes the result, minus the api key.
  const cacheKey = `${config.jackettUrl}|${config.jackettIndexer}|${config.searchCategories.join(',')}|${query}`;
  return jackettCache.wrap(cacheKey, async () => {
    log.debug(`Jackett query "${query}" via indexer ${config.jackettIndexer}`);
    const started = Date.now();
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(JACKETT_TIMEOUT_MS) });
    } catch (e) {
      const secs = Math.round((Date.now() - started) / 1000);
      const reason = e.name === 'TimeoutError' || /abort/i.test(String(e.message))
        ? `timed out after ${secs}s (indexer "${config.jackettIndexer}" waits for the slowest tracker; try a specific indexer or raise JACKETT_TIMEOUT_MS)`
        : e.message;
      log.error(`Jackett request failed for "${query}": ${reason}`);
      throw new Error(`Could not reach Jackett: ${reason}`);
    }
    if (!r.ok) { log.error(`Jackett returned ${r.status} for "${query}"`); throw new Error(`Jackett ${r.status}`); }
    const data = await r.json();
    log.debug(`Jackett query "${query}" answered in ${Math.round((Date.now() - started) / 1000)}s with ${(data.Results || []).length} results`);
    return data.Results || [];
  });
}

/** Verify Jackett URL/key/indexer via the Torznab caps endpoint, which
 *  answers instantly without querying any trackers (a real search against the
 *  "all" aggregate can take minutes and made the test time out). */
export async function testJackett({ url, apiKey, indexer }) {
  const base = (url || '').replace(/\/$/, '');
  if (!base || !apiKey) throw new Error('URL and API key are required');
  const params = new URLSearchParams({ apikey: apiKey, t: 'caps' });
  const r = await fetch(`${base}/api/v2.0/indexers/${indexer || 'all'}/results/torznab/api?${params}`, { signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error('Jackett rejected the API key');
  if (r.status === 404) throw new Error('Indexer not found — check the URL (no /api suffix) and the indexer id');
  if (!r.ok) throw new Error(`Jackett returned ${r.status}`);
  const text = await r.text();
  if (/<error\b/i.test(text)) {
    const desc = text.match(/description="([^"]*)"/)?.[1];
    throw new Error(desc || 'Jackett returned an error');
  }
  return true;
}

const norm = s => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * Score indexer results against what we want. `mustTokens` come from the
 * artist name, `wantTokens` from the album/track title.
 */
export function scoreResults(results, artist, title) {
  const mustTokens = norm(artist).split(' ').filter(t => t.length > 1);
  const wantTokens = norm(title).split(' ').filter(t => t.length > 1);
  const scored = [];
  for (const r of results) {
    const t = ' ' + norm(r.Title) + ' ';
    let score = 0;
    const mustHits = mustTokens.filter(tok => t.includes(' ' + tok + ' ') || t.includes(tok)).length;
    const wantHits = wantTokens.filter(tok => t.includes(tok)).length;
    if (mustTokens.length && mustHits === 0) continue;          // wrong artist
    if (wantTokens.length && wantHits === 0) continue;          // wrong title
    score += (mustHits / Math.max(1, mustTokens.length)) * 50;
    score += (wantHits / Math.max(1, wantTokens.length)) * 50;
    if (/flac/i.test(r.Title)) score += 15;
    else if (/320/.test(r.Title)) score += 10;
    if (/discography|collection|complete/i.test(r.Title)) score -= 20; // too big
    const seeders = r.Seeders ?? 0;
    if (seeders === 0) score -= 100;                            // dead torrent
    score += Math.min(15, seeders);
    if (!r.MagnetUri && !r.Link) continue;
    scored.push({ result: r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ---------------------------------------------------------- Transmission */
let tmSessionId = '';

async function tmCall(method, args) {
  const headers = { 'Content-Type': 'application/json', 'X-Transmission-Session-Id': tmSessionId };
  if (config.transmissionUser) {
    headers.Authorization = 'Basic ' + Buffer.from(`${config.transmissionUser}:${config.transmissionPass}`).toString('base64');
  }
  const body = JSON.stringify({ method, arguments: args });
  let r = await fetch(config.transmissionUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  if (r.status === 409) { // refresh CSRF session id and retry once
    tmSessionId = r.headers.get('x-transmission-session-id') || '';
    headers['X-Transmission-Session-Id'] = tmSessionId;
    r = await fetch(config.transmissionUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  }
  if (!r.ok) throw new Error(`Transmission ${r.status}`);
  const data = await r.json();
  if (data.result !== 'success') throw new Error(`Transmission: ${data.result}`);
  return data.arguments;
}

/** Verify a Transmission RPC endpoint (and optional auth). Throws on failure. */
export async function testTransmission({ url, username, password }) {
  if (!url) throw new Error('RPC URL is required');
  const headers = { 'Content-Type': 'application/json' };
  if (username) headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
  const body = JSON.stringify({ method: 'session-get' });
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    if (r.status === 409) { // CSRF handshake, retry once with the session id
      headers['X-Transmission-Session-Id'] = r.headers.get('x-transmission-session-id') || '';
      r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    }
  } catch (e) {
    throw new Error(`Could not reach Transmission: ${e.message}`);
  }
  if (r.status === 401) throw new Error('Transmission rejected the username/password');
  if (!r.ok) throw new Error(`Transmission returned ${r.status}`);
  return true;
}

/** Add a torrent (magnet URI or .torrent URL). Returns { hashString, name }. */
export async function tmAdd(magnetOrUrl, subdir) {
  const args = {
    filename: magnetOrUrl,
    'download-dir': `${config.downloadDir}/${subdir}`,
  };
  const out = await tmCall('torrent-add', args);
  const t = out['torrent-added'] || out['torrent-duplicate'];
  if (!t) throw new Error('Transmission did not accept the torrent');
  return t;
}

export async function tmStatus(hashes) {
  const out = await tmCall('torrent-get', {
    ids: hashes,
    fields: ['hashString', 'name', 'percentDone', 'isFinished', 'downloadDir', 'errorString', 'status'],
  });
  return out.torrents || [];
}

export async function tmRemove(hash) {
  await tmCall('torrent-remove', { ids: [hash], 'delete-local-data': false });
}
