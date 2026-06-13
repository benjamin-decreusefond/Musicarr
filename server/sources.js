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

const norm = s => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/* ------------------------------------------------------------ slskd (Soulseek) */
// slskd is both the search engine and the download client: Soulseek peers
// share individual files, so we can grab exactly one song — or a whole album
// folder from a single peer.
const AUDIO_EXT_RE = /\.(flac|mp3|m4a|ogg|opus|wav|aac|wma)$/i;

async function slskdFetch(pathAndQuery, opts = {}) {
  if (!config.slskdUrl || !config.slskdApiKey) throw new Error('slskd URL / API key not configured');
  const r = await fetch(`${config.slskdUrl}/api/v0/${pathAndQuery}`, {
    ...opts,
    headers: { 'X-API-Key': config.slskdApiKey, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || 20000),
  });
  if (r.status === 401 || r.status === 403) throw new Error('slskd rejected the API key');
  if (!r.ok) throw new Error(`slskd ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/** Verify a slskd endpoint + API key. */
export async function testSlskd({ url, apiKey }) {
  const base = (url || '').replace(/\/$/, '');
  if (!base || !apiKey) throw new Error('URL and API key are required');
  let r;
  try {
    r = await fetch(`${base}/api/v0/session`, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`Could not reach slskd: ${e.message}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error('slskd rejected the API key');
  if (!r.ok) throw new Error(`slskd returned ${r.status}`);
  // Also report whether slskd is actually logged in to the Soulseek network —
  // an API that answers but a server connection that's down means searches
  // will silently return nothing.
  let serverState = 'unknown';
  try {
    const s = await fetch(`${base}/api/v0/server`, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10000) });
    if (s.ok) serverState = (await s.json())?.state || 'unknown';
  } catch { /* optional */ }
  return { serverState };
}

/** Current slskd <-> Soulseek server connection state (e.g. "Connected, LoggedIn"). */
export async function slskdServerState() {
  try { return (await slskdFetch('server'))?.state || 'unknown'; }
  catch { return 'unreachable'; }
}

/** Run a Soulseek search and return the flattened candidate audio files,
 *  each tagged with its peer and the peer's slot/queue info. */
export async function slskdSearch(query, { timeoutMs = 45000 } = {}) {
  // Give slskd explicit search parameters: a real search window, a generous
  // response cap, and (crucially) filterResponses:false so peers without a
  // free slot right now still surface — we rank those ourselves. Without this,
  // a popular track can come back empty even though the slskd UI finds it.
  const searchTimeout = Math.max(5000, Math.min(timeoutMs - 5000, 15000));
  const search = await slskdFetch('searches', {
    method: 'POST',
    body: JSON.stringify({ searchText: query, searchTimeout, responseLimit: 250, fileLimit: 20000, filterResponses: false }),
  });
  const id = search?.id;
  if (!id) throw new Error('slskd did not return a search id');

  // Wait for the search to actually finish (slskd flips isComplete when its
  // searchTimeout elapses); don't bail early on a transient empty state.
  const deadline = Date.now() + timeoutMs;
  let state = search;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 1500));
    state = await slskdFetch(`searches/${id}`);
    if (state?.isComplete) break;
    if ((state?.responseCount ?? 0) >= 50) break; // plenty already
  }
  let responses = [];
  try { responses = await slskdFetch(`searches/${id}/responses`) || []; } catch { /* ignore */ }
  try { await slskdFetch(`searches/${id}`, { method: 'DELETE' }); } catch { /* best effort cleanup */ }

  const totalFiles = responses.reduce((n, r) => n + (r.files?.length || 0), 0);
  log.info(`slskd "${query}": state=${state?.state || (state?.isComplete ? 'Completed' : 'Incomplete')}, ${responses.length} response(s), ${totalFiles} file(s)`);
  if (!responses.length) {
    // Zero responses for any real-world query almost always means a network
    // problem, not a missing song: search replies are delivered by peers
    // connecting back to slskd, so an unreachable listen port (VPN/NAT
    // without port forwarding) or a dropped server login yields nothing.
    const serverState = await slskdServerState();
    log.warn(`slskd returned ZERO responses (server state: ${serverState}). `
      + `If this happens for popular tracks, slskd's listen port is likely unreachable `
      + `(VPN/NAT without port forwarding) or slskd is not logged in — check slskd's web UI.`);
  }

  const out = [];
  for (const resp of responses) {
    for (const f of (resp.files || [])) {
      if (!AUDIO_EXT_RE.test(f.filename || '')) continue;
      out.push({
        username: resp.username,
        filename: f.filename,
        size: f.size || 0,
        bitRate: f.bitRate || 0,
        length: f.length || 0,                      // seconds
        hasFreeUploadSlot: !!resp.hasFreeUploadSlot,
        queueLength: resp.queueLength ?? 0,
        uploadSpeed: resp.uploadSpeed ?? 0,
      });
    }
  }
  return out;
}

/** Enqueue one or more file downloads from a peer. */
export async function slskdEnqueue(username, files) {
  const list = (Array.isArray(files) ? files : [files]).map(f => ({ filename: f.filename, size: f.size }));
  await slskdFetch(`transfers/downloads/${encodeURIComponent(username)}`, {
    method: 'POST',
    body: JSON.stringify(list),
  });
  return true;
}

/** All download transfers for a peer, flattened.
 *  Each: { id, filename, state, percentComplete, bytesTransferred, size }. */
export async function slskdTransfers(username) {
  let dirs;
  try { dirs = await slskdFetch(`transfers/downloads/${encodeURIComponent(username)}`); }
  catch { return []; }
  // Response is { username, directories: [{ directory, files: [transfer...] }] }
  return (dirs?.directories || []).flatMap(d => d.files || []);
}

export async function slskdCancel(username, id) {
  try { await slskdFetch(`transfers/downloads/${encodeURIComponent(username)}/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
}

/** Rank candidate files for one wanted track. Returns them best-first, after
 *  dropping ones whose filename clearly doesn't match the title/artist. */
export function scoreSlskdFiles(files, artist, title, durationSec) {
  const must = norm(artist).split(' ').filter(t => t.length > 1);
  const want = norm(title).split(' ').filter(t => t.length > 1);
  const scored = [];
  for (const f of files) {
    const base = (f.filename || '').split(/[\\/]/).pop();
    const hay = ' ' + norm(base) + ' ' + norm(f.filename) + ' ';
    const titleHits = want.filter(t => hay.includes(t)).length;
    if (want.length && titleHits === 0) continue;                     // wrong song
    const artistHits = must.filter(t => hay.includes(t)).length;
    const durKnown = durationSec && f.length;
    const durClose = durKnown && Math.abs(f.length - durationSec) <= 12;
    // Broad ("title only") searches can return a different artist's song with
    // the same title. If the artist name isn't anywhere in the path, only trust
    // the file when its duration matches the Deezer track; if we can't even
    // check the duration, drop it rather than risk the wrong recording.
    if (must.length && artistHits === 0) {
      if (!durKnown || !durClose) continue;
    }
    let score = (titleHits / Math.max(1, want.length)) * 50;
    score += (artistHits / Math.max(1, must.length)) * 30;
    if (/\.flac$/i.test(base)) score += 20;
    else if (f.bitRate >= 320 || /320/.test(base)) score += 12;
    else if (f.bitRate && f.bitRate < 192) score -= 10;
    if (f.hasFreeUploadSlot) score += 25;                             // available now
    score -= Math.min(20, (f.queueLength || 0));                      // long queue is bad
    score += Math.min(10, (f.uploadSpeed || 0) / 100000);
    if (durClose) score += 10;                                        // duration confirms it
    else if (durKnown && Math.abs(f.length - durationSec) > 15) score -= 15;
    scored.push({ file: f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.file);
}

/** Group search results into per-peer folders and rank them as album
 *  candidates: how many of the wanted track titles the folder covers, then
 *  quality/availability. Returns [{ username, directory, files, matched }]
 *  best-first; folders covering less than half the album are dropped. */
export function scoreSlskdFolders(files, wantedTitles) {
  const wanted = wantedTitles.map(t => norm(t)).filter(Boolean);
  const folders = new Map(); // username|dir -> { username, directory, files }
  for (const f of files) {
    const dir = (f.filename || '').replace(/[\\/][^\\/]+$/, '');
    const key = `${f.username}|${dir}`;
    if (!folders.has(key)) folders.set(key, { username: f.username, directory: dir, files: [] });
    folders.get(key).files.push(f);
  }
  const scored = [];
  for (const folder of folders.values()) {
    const bases = folder.files.map(f => norm((f.filename || '').split(/[\\/]/).pop()));
    const matched = wanted.filter(w => bases.some(b => b.includes(w) || (w.length > 6 && w.includes(b)))).length;
    if (matched < Math.max(1, Math.ceil(wanted.length / 2))) continue;  // too incomplete
    let score = (matched / Math.max(1, wanted.length)) * 100;
    const flacShare = folder.files.filter(f => /\.flac$/i.test(f.filename)).length / folder.files.length;
    score += flacShare * 15;
    if (folder.files[0]?.hasFreeUploadSlot) score += 20;
    score -= Math.min(20, folder.files[0]?.queueLength || 0);
    scored.push({ ...folder, matched, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
