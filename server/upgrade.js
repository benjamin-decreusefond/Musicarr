// Quality upgrades: go back for a better copy of what's already in the library.
//
// Soulseek gives you whatever the first willing peer had. A year later half the
// library is 192kbps rips of albums that are widely shared in FLAC, and the only
// way to fix it was to delete tracks and re-request them by hand. This sweep
// does it on a schedule: find files below the profile's target, queue one
// download each marked as an upgrade, and let the import replace them.
//
// Two properties keep it from becoming a nuisance:
//   - it searches *only* for the target format, so anything that comes back is
//     an improvement by construction and never has to be second-guessed;
//   - a track nobody shares in the target format is stamped as checked, so it
//     drops out of the candidate list instead of being re-searched every pass.
import fs from 'node:fs';
import { db, config } from './db.js';
import { logger, withRequestId } from './log.js';
import { queueDownload } from './downloader.js';
import { readAudioQuality, meetsTarget } from './quality.js';
import { inc } from './metrics.js';

const log = logger('upgrade');

// Don't reconsider a track we already failed to improve until this long has
// passed — the Soulseek catalog changes slowly.
const RECHECK_AFTER_DAYS = 30;

/** Fill in audio_format/bitrate for library files that predate quality tracking
 *  (or were imported before this feature existed). Bounded per call so a large
 *  library is backfilled over a few sweeps instead of one long stall. */
export async function backfillQuality(limit = 200) {
  const rows = db.prepare(`
    SELECT deezer_id, file_path FROM tracks
    WHERE file_path IS NOT NULL AND audio_format IS NULL
    LIMIT ?`).all(limit);
  let done = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.file_path)) continue;      // scanLibrary will prune it
    const { format, bitrate } = await readAudioQuality(r.file_path);
    db.prepare('UPDATE tracks SET audio_format = ?, bitrate = ? WHERE deezer_id = ?')
      .run(format || null, bitrate ?? null, r.deezer_id);
    done++;
  }
  if (done) log.info(`recorded the quality of ${done} existing file(s)`);
  return done;
}

/** Library tracks that are below the target and worth searching for again. */
export function upgradeCandidates(limit = config.upgradeBatchSize) {
  if (!config.qualityTarget) return [];
  const rows = db.prepare(`
    SELECT deezer_id, title, artist, album, cover, audio_format, bitrate
    FROM tracks
    WHERE file_path IS NOT NULL
      AND in_library = 1
      AND audio_format IS NOT NULL
      AND (upgrade_checked_at IS NULL OR upgrade_checked_at < datetime('now', ?))
      -- Never queue a second upgrade for a track that already has one running.
      AND NOT EXISTS (
        SELECT 1 FROM downloads d
        WHERE d.is_upgrade = 1 AND d.kind = 'track' AND d.deezer_id = tracks.deezer_id
          AND d.status IN ('searching', 'downloading', 'importing'))
    ORDER BY added_at DESC`).all(`-${RECHECK_AFTER_DAYS} days`);
  // The target comparison lives in quality.js rather than in SQL: "is this good
  // enough" is a real rule (lossless beats everything, a lossy target has a
  // bitrate floor), not something worth expressing twice.
  return rows.filter(r => !meetsTarget(r)).slice(0, limit);
}

/** Mark a track as looked-at, so a failed search doesn't repeat every sweep. */
export function markUpgradeChecked(deezerId) {
  db.prepare(`UPDATE tracks SET upgrade_checked_at = datetime('now') WHERE deezer_id = ?`).run(deezerId);
}

/** One pass: backfill what we don't know, then queue a bounded batch of
 *  upgrades. Returns how many were queued. */
export async function runUpgradeSweep({ force = false } = {}) {
  // `force` is the Settings button: it runs even when the periodic sweep is
  // off, so someone can try the profile out before committing to a schedule.
  // A target format is still required — without one there is nothing to aim at.
  if (!force && !config.qualityUpgradeEnabled) return 0;
  if (force && !config.qualityTarget) return 0;
  await backfillQuality();

  const candidates = upgradeCandidates();
  if (!candidates.length) return 0;

  // Upgrades are attributed to an admin: they're a server-wide maintenance
  // action, not something a particular listener asked for.
  const owner = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (!owner) { log.warn('no admin user to attribute upgrades to — skipping'); return 0; }

  log.info(`looking for ${config.qualityTarget.toUpperCase()} copies of ${candidates.length} track(s)`);
  for (const t of candidates) {
    // Stamped up front, not on failure: if the search finds nothing the row is
    // already excluded from the next sweep, and a successful import clears it
    // again (see import.js), so the state is correct whichever way it ends.
    markUpgradeChecked(t.deezer_id);
    queueDownload(owner.id, 'track', t.deezer_id, `${t.artist} – ${t.title}`, t.cover, { upgrade: true });
    inc('musicarr_upgrades_total', { from: t.audio_format || 'unknown' });
  }
  return candidates.length;
}

/** Start the periodic sweep. Off unless a target format is configured. */
export function startUpgradeWatcher() {
  if (!config.qualityUpgradeEnabled) {
    log.info('quality upgrades are off (no target format set)');
    return null;
  }
  const tick = () => withRequestId('upgrade-sweep', () =>
    runUpgradeSweep().catch(e => log.error('upgrade sweep failed', e)));
  const timer = setInterval(tick, config.upgradeIntervalMs);
  timer.unref?.();
  log.info(`upgrade sweep every ${Math.round(config.upgradeIntervalMs / 60000)}min, target ${config.qualityTarget}`);
  return timer;
}
