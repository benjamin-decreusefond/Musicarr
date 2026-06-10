import { Router } from 'express';
import { config } from './db.js';

/* ---------------------------------------------------------------- Deezer */
// Free, key-less metadata API. We proxy it server-side (no CORS issues, and
// responses get a short cache).
const DEEZER = 'https://api.deezer.com';
const ALLOWED = [
  /^search(\/(track|album|artist))?$/,
  /^track\/\d+$/,
  /^album\/\d+(\/tracks)?$/,
  /^artist\/\d+(\/(top|albums|related|radio))?$/,
  /^chart(\/0\/(tracks|albums|artists))?$/,
  /^genre$/,
  /^editorial\/\d+\/charts$/,
];

const cache = new Map(); // url -> { at, body }
const CACHE_MS = 5 * 60 * 1000;

export async function deezerGet(pathAndQuery) {
  const url = `${DEEZER}/${pathAndQuery}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Deezer ${r.status}`);
  const body = await r.json();
  if (cache.size > 500) cache.clear();
  cache.set(url, { at: Date.now(), body });
  return body;
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
export async function jackettSearch(query) {
  if (!config.jackettUrl || !config.jackettApiKey) {
    throw new Error('JACKETT_URL / JACKETT_API_KEY not configured');
  }
  const params = new URLSearchParams({ apikey: config.jackettApiKey, Query: query });
  for (const c of config.searchCategories) params.append('Category[]', c);
  const url = `${config.jackettUrl}/api/v2.0/indexers/${config.jackettIndexer}/results?${params}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`Jackett ${r.status}`);
  const data = await r.json();
  return data.Results || [];
}

/** Verify Jackett credentials by issuing a trivial search. Throws on failure. */
export async function testJackett({ url, apiKey, indexer }) {
  const base = (url || '').replace(/\/$/, '');
  if (!base || !apiKey) throw new Error('URL and API key are required');
  const params = new URLSearchParams({ apikey: apiKey, Query: 'test' });
  const r = await fetch(`${base}/api/v2.0/indexers/${indexer || 'all'}/results?${params}`, { signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error('Jackett rejected the API key');
  if (!r.ok) throw new Error(`Jackett returned ${r.status}`);
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
    'download-dir': `${config.transmissionDownloadDir}/${subdir}`,
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
