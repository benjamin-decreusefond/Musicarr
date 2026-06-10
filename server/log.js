// Tiny leveled logger. Writes single-line, timestamped records to stdout/stderr
// so they show up in `docker logs` / `kubectl logs`. Set LOG_LEVEL to one of
// error|warn|info|debug (default info) to control verbosity.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] > threshold) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined && extra !== null) {
    line += ' ' + (extra instanceof Error
      ? (extra.stack || extra.message)
      : typeof extra === 'string' ? extra : JSON.stringify(extra));
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
