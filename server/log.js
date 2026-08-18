// Tiny leveled logger. Writes single-line, timestamped records to stdout/stderr
// so they show up in `docker logs` / `kubectl logs`. Set LOG_LEVEL to one of
// error|warn|info|debug (default info) to control verbosity.
//
// LOG_FORMAT=json switches every record to one JSON object per line, which is
// what a log pipeline (Loki, Elasticsearch, CloudWatch) needs to index fields
// instead of regex-scraping a sentence. The human-readable text format stays the
// default so `docker logs` on a laptop is still readable.
//
// Records carry the id of the request that produced them, so the twenty lines a
// failed album download writes across four modules can be pulled up as one
// story. The id rides in an AsyncLocalStorage, meaning call sites don't have to
// thread it through — anything logged while handling a request picks it up, even
// several awaits deep.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const asJson = (process.env.LOG_FORMAT || 'text').toLowerCase() === 'json';

// Per-request state. Empty outside a request (timers, the poller, boot).
const requestStore = new AsyncLocalStorage();

/** The current request's id, or null when not handling a request. */
export const currentRequestId = () => requestStore.getStore()?.requestId ?? null;

/** Normalize the optional second logging argument into JSON-friendly fields. */
function extraFields(extra) {
  if (extra === undefined || extra === null || extra === '') return null;
  if (extra instanceof Error) return { error: extra.message, stack: extra.stack };
  if (typeof extra === 'object') return extra;
  return { detail: String(extra) };
}

function emit(level, scope, msg, extra) {
  if (LEVELS[level] > threshold) return;
  const ts = new Date().toISOString();
  const requestId = currentRequestId();
  const fields = extraFields(extra);
  let line;

  if (asJson) {
    // Deliberately assembled in this order: a truncated line still shows when,
    // how bad, and where. `msg` is never allowed to be shadowed by a field.
    line = JSON.stringify({ ts, level, scope, ...(requestId ? { requestId } : {}), ...fields, msg });
  } else {
    line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]${requestId ? ` (${requestId})` : ''} ${msg}`;
    if (fields) {
      line += ' ' + (extra instanceof Error
        ? (extra.stack || extra.message)
        : typeof extra === 'string' ? extra : JSON.stringify(extra));
    }
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

/** Create a logger bound to a scope, e.g. logger('download'). */
export function logger(scope) {
  return {
    error: (msg, extra) => emit('error', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    debug: (msg, extra) => emit('debug', scope, msg, extra),
  };
}

/** Run `fn` with a request id bound to the async context. Exported for the
 *  background jobs (the poller, the release watcher) that want their own
 *  correlation id without being an HTTP request. */
export function withRequestId(requestId, fn) {
  return requestStore.run({ requestId }, fn);
}

// A client-supplied id is echoed back so a reverse proxy or a desktop client can
// correlate its own logs with ours — but only if it looks like an id. Accepting
// arbitrary text would let a caller inject newlines (and therefore fake records)
// into the log stream.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Express middleware: bind a request id to the async context, echo it on the
 *  response, and log one access record per request. */
export function requestContext({ log = logger('http'), onFinish = null } = {}) {
  return (req, res, next) => {
    const inbound = req.headers['x-request-id'];
    const requestId = SAFE_ID.test(inbound || '') ? inbound : randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', requestId);
    const startedAt = process.hrtime.bigint();

    requestStore.run({ requestId }, () => {
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        // The route, not the URL: /api/tracks/12345 and /api/tracks/999 are the
        // same endpoint, and keeping ids out bounds the label cardinality for
        // whatever consumes these (and keeps track ids out of the log).
        const route = req.route?.path ? req.baseUrl + req.route.path : req.baseUrl || req.path;
        if (onFinish) onFinish({ method: req.method, route, status: res.statusCode, ms });
        // A 5xx is a defect and belongs at warn; everything else is traffic.
        const level = res.statusCode >= 500 ? 'warn' : 'debug';
        log[level](`${req.method} ${req.originalUrl} ${res.statusCode}`,
          { method: req.method, route, status: res.statusCode, durationMs: Math.round(ms * 10) / 10 });
      });
      next();
    });
  };
}
