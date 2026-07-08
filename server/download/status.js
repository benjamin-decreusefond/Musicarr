// Download-row status updates: persist to SQLite, log, and push over SSE.
import { db } from '../db.js';
import { publish } from '../events.js';
import { logger } from '../log.js';

const log = logger('download');

/** Push a download row to its owner (and admins) over SSE, so the Downloads
 *  view updates live instead of polling. Best-effort. */
export function publishDownload(id) {
  try {
    const row = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
    if (row) publish('download', row, { userId: row.user_id, adminAlso: true });
  } catch { /* never let a push failure break the download flow */ }
}

export function setStatus(id, status, detail, extra = {}) {
  const fields = { status, detail: detail ?? null, ...extra };
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE downloads SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ id, ...fields });
  if (status === 'error' || status === 'not_found') log.warn(`#${id} -> ${status}`, detail || '');
  else log.info(`#${id} -> ${status}`, detail || '');
  publishDownload(id);
}
