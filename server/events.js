// Server-Sent Events hub: pushes live updates (download progress, Listen
// Together state) to signed-in clients so they don't have to poll. One
// long-lived GET /api/events connection per client; events are filtered
// per-user at publish time. Best-effort by design — clients keep a slow
// polling fallback, so a dropped SSE connection never loses data.
import { logger } from './log.js';

const log = logger('events');

const clients = new Set(); // { res, userId, isAdmin }
const PING_MS = 25_000;    // keep proxies from idling the connection out

/** Express handler for GET /api/events (behind requireAuth). */
export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  res.write('retry: 3000\n\n');
  const client = { res, userId: req.user.id, isAdmin: !!req.user.is_admin };
  clients.add(client);
  log.debug(`client connected (user ${client.userId}); ${clients.size} online`);
  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { /* cleaned up on close */ }
  }, PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
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
