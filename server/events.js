// Server-Sent Events hub: pushes live updates (download progress, Listen
// Together state) to signed-in clients so they don't have to poll. One
// long-lived GET /api/events connection per client; events are filtered
// per-user at publish time. Best-effort by design — clients keep a slow
// polling fallback, so a dropped SSE connection never loses data.
import { logger } from './log.js';

const log = logger('events');

const clients = new Set(); // { res, userId, isAdmin }
const PING_MS = 25_000;    // keep proxies from idling the connection out
// A browser opens one stream per tab, so a handful per user is normal. A client
// that reconnects without closing (a flapping proxy, a buggy tab) would
// otherwise pile up response objects here for as long as the process lives, so
// evict that user's oldest stream once they exceed the cap.
const MAX_STREAMS_PER_USER = 8;

/** Forget a client and stop its keep-alive. Both teardown paths (the request
 *  closing, and eviction at the per-user cap) must clear the interval — leaving
 *  it running would keep writing to a dead response forever. */
function drop(client) {
  clearInterval(client.ping);
  clients.delete(client);
}

/** Express handler for GET /api/events (behind requireAuth). */
export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  res.write('retry: 3000\n\n');
  const client = { res, userId: req.user.id, isAdmin: !!req.user.is_admin, ping: null };
  // Sets preserve insertion order, so the first match is this user's oldest.
  const mine = [...clients].filter(c => c.userId === client.userId);
  while (mine.length >= MAX_STREAMS_PER_USER) {
    const oldest = mine.shift();
    drop(oldest);
    try { oldest.res.end(); } catch { /* already gone */ }
    log.debug(`evicted a stale stream for user ${client.userId} (cap ${MAX_STREAMS_PER_USER})`);
  }
  clients.add(client);
  log.debug(`client connected (user ${client.userId}); ${clients.size} online`);
  client.ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { /* cleaned up on close */ }
  }, PING_MS);
  req.on('close', () => {
    drop(client);
    log.debug(`client disconnected (user ${client.userId}); ${clients.size} online`);
  });
}

/**
 * Send `data` as a named SSE event.
 *  - userId: deliver only to that user's connections (null = everyone).
 *  - userIds: deliver to a set of users (e.g. Listen Together members).
 *  - adminAlso: additionally deliver to admins (they see all downloads).
 *  - adminOnly: deliver exclusively to admins (e.g. library scan progress).
 */
export function publish(event, data, { userId = null, userIds = null, adminAlso = false, adminOnly = false } = {}) {
  if (!clients.size) return;
  const wanted = userIds ? new Set(userIds) : null;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    const targeted = adminOnly
      ? c.isAdmin
      : (wanted ? wanted.has(c.userId) : (userId == null || c.userId === userId));
    if (!targeted && !(adminAlso && c.isAdmin)) continue;
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}
