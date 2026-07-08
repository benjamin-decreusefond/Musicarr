// Poll loop: watch active slskd transfers (progress, stalls, completion),
// trigger imports, fail over to the next candidate on failure, and sweep for
// downloads that finished but never made it into the library.
import fs from 'node:fs';
import { db, config } from '../db.js';
import { slskdTransfers, slskdCancel, slskdReady } from '../sources.js';
import { logger } from '../log.js';
import { slskdFilesOf, TERMINAL, SUCCEEDED } from './util.js';
import { setStatus } from './status.js';
import { recordPeerStrike, clearPeerStrikes } from './peers.js';
import { candidateKey, failedCandidatesOf, PER_CANDIDATE_MAX, MAX_ATTEMPTS } from './retry.js';
import { pendingImports, progressTrack, importDownload, rebuildPlan } from './import.js';
import { runSearch } from './search.js';
import { cleanupStaleTracks } from './library.js';

const log = logger('download');

export function startPoller() {
  log.info(`poll loop started, every ${config.pollIntervalMs}ms (unimported sweep every ${config.sweepIntervalMs}ms)`);
  setInterval(() => tick().catch(e => log.error('poll tick failed', e)), config.pollIntervalMs);
  setTimeout(() => sweepUnimported().catch(e => log.error('sweep failed', e)), Math.min(15000, config.sweepIntervalMs));
  setInterval(() => sweepUnimported().catch(e => log.error('sweep failed', e)), config.sweepIntervalMs);
  // Auto-cleanup of stale tracks: shortly after boot, then daily.
  setTimeout(() => cleanupStaleTracks().catch(e => log.error('cleanup failed', e)), 60000);
  setInterval(() => cleanupStaleTracks().catch(e => log.error('cleanup failed', e)), 24 * 60 * 60 * 1000);
}

/** A transfer failed (terminal error or stalled): record the candidate,
 *  cancel leftovers, and either re-search with that candidate excluded or
 *  give up after MAX_ATTEMPTS. */
async function handleTransferFailure(dl, reason) {
  pendingImports.delete(dl.id);
  progressTrack.delete(dl.id);

  // Best-effort: cancel whatever is still queued at the peer so slskd stops
  // pulling a candidate we've given up on.
  try {
    const transfers = await slskdTransfers(dl.slskd_user);
    const mine = new Set(slskdFilesOf(dl));
    for (const t of transfers) {
      if (mine.has(t.filename) && !TERMINAL.test(t.state || '')) await slskdCancel(dl.slskd_user, t.id);
    }
  } catch { /* ignore */ }

  const fails = failedCandidatesOf(dl);
  const key = candidateKey(dl.slskd_user, slskdFilesOf(dl)[0]);
  fails[key] = (fails[key] || 0) + 1;
  recordPeerStrike(dl.slskd_user);
  const attempts = (dl.attempts || 0) + 1;

  if (attempts >= MAX_ATTEMPTS) {
    return setStatus(dl.id, 'error', `Soulseek transfer failed (${reason}) — gave up after ${attempts} attempts`, {
      attempts, failed_candidates: JSON.stringify(fails),
    });
  }
  log.info(`#${dl.id} transfer from ${dl.slskd_user} failed (${reason}); retrying — attempt ${attempts + 1}/${MAX_ATTEMPTS}, candidate strike ${fails[key]}/${PER_CANDIDATE_MAX}`);
  setStatus(dl.id, 'searching', `Transfer failed (${reason}) — retrying (attempt ${attempts + 1})`, {
    attempts, failed_candidates: JSON.stringify(fails),
    slskd_user: null, slskd_file: null, progress: 0,
  });
  runSearch(dl.id);
}

async function tick() {
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND slskd_user IS NOT NULL`).all();
  for (const dl of active) {
    const wantedFiles = slskdFilesOf(dl);
    if (!wantedFiles.length) continue;
    let transfers;
    try { transfers = await slskdTransfers(dl.slskd_user); }
    catch (e) { log.warn(`#${dl.id} could not poll slskd: ${e.message}`); continue; }
    const byName = new Map(transfers.map(t => [t.filename, t]));
    const mine = wantedFiles.map(f => byName.get(f)).filter(Boolean);
    if (!mine.length) continue; // not visible yet

    const done = mine.filter(t => TERMINAL.test(t.state || ''));
    const ok = done.filter(t => SUCCEEDED.test(t.state || ''));
    if (done.length < wantedFiles.length) {
      // Aggregate progress across the transfer set.
      const pct = mine.reduce((sum, t) => {
        const p = t.percentComplete != null ? t.percentComplete / 100
          : (t.size ? (t.bytesTransferred || 0) / t.size : 0);
        return sum + Math.min(1, p);
      }, 0) / wantedFiles.length;
      if (Math.abs(pct - dl.progress) > 0.01) setStatus(dl.id, 'downloading', dl.detail, { progress: pct });
      // Stall guard: a peer can leave us queued or frozen forever — after
      // slskdStallMs with no progress, fail over to the next candidate.
      const prev = progressTrack.get(dl.id);
      if (!prev || pct > prev.pct + 0.001) {
        progressTrack.set(dl.id, { pct, at: Date.now() });
      } else if (Date.now() - prev.at > config.slskdStallMs) {
        await handleTransferFailure(dl, `stalled at ${Math.round(pct * 100)}% for ${Math.round(config.slskdStallMs / 60000)}min`);
      }
      continue;
    }
    if (!ok.length) {
      await handleTransferFailure(dl, done[0]?.state || 'unknown state');
      continue;
    }
    // All transfers terminal and at least one succeeded -> import.
    setStatus(dl.id, 'importing', 'Importing files', { progress: 1 });
    try {
      const n = await importDownload(dl);
      clearPeerStrikes(dl.slskd_user); // the peer delivered: forgive past strikes
      setStatus(dl.id, 'done', n > 1 ? `Imported ${n} tracks to your library` : 'Added to your library', { progress: 1 });
    } catch (e) {
      // A failed verification (wrong file) should try the next peer, not just error out.
      if (e?.failover) { await handleTransferFailure(dl, String(e.message || e)); continue; }
      setStatus(dl.id, 'error', String(e.message || e));
    }
    pendingImports.delete(dl.id);
    progressTrack.delete(dl.id);
  }
}

/* ------------------------------------------------------------ Sweep */
// Retry downloads whose files finished but never made it into the library
// (crash mid-import, slskd volume briefly unmounted, ...). Each download gets
// at most one retry per hour and MAX_SWEEP_RETRIES in total per process —
// a permanently-failed import must not walk the download tree hourly forever.
const sweepAttempts = new Map(); // dl.id -> { at: ms, n: attempts }
const MAX_SWEEP_RETRIES = 5;
export async function sweepUnimported() {
  const candidates = db.prepare(`
    SELECT * FROM downloads
    WHERE status IN ('error', 'importing') AND slskd_user IS NOT NULL
      AND updated_at > datetime('now', '-7 days')
  `).all();
  for (const dl of candidates) {
    const rec = sweepAttempts.get(dl.id) || { at: 0, n: 0 };
    if (Date.now() - rec.at < 60 * 60 * 1000 || rec.n >= MAX_SWEEP_RETRIES) continue;
    sweepAttempts.set(dl.id, { at: Date.now(), n: rec.n + 1 });
    try {
      if (!pendingImports.has(dl.id)) await rebuildPlan(dl);
      const plan = pendingImports.get(dl.id);
      const missing = (plan?.wantedTracks || []).filter(w => {
        const t = db.prepare('SELECT file_path FROM tracks WHERE deezer_id = ?').get(w.deezer_id);
        return !(t?.file_path && fs.existsSync(t.file_path));
      });
      if (!missing.length) { pendingImports.delete(dl.id); continue; }
      log.info(`sweep: download #${dl.id} (${dl.label}) has ${missing.length} unimported track(s), retrying import`);
      const n = await importDownload(dl);
      setStatus(dl.id, 'done', n > 1 ? `Imported ${n} tracks to your library` : 'Added to your library', { progress: 1 });
    } catch (err) {
      log.debug(`sweep: #${dl.id} retry failed: ${err.message}`);
    } finally {
      pendingImports.delete(dl.id);
    }
  }

  // Re-drive searches that failed only because slskd was temporarily down
  // (status 'error', nothing ever started transferring). Retry once slskd is
  // healthy again, at most every 30 min per download, for up to a day.
  let healthy = false;
  try { healthy = await slskdReady(); } catch { /* treat as not healthy */ }
  if (healthy) {
    const retry = db.prepare(`
      SELECT * FROM downloads
      WHERE status = 'error' AND slskd_user IS NULL
        AND updated_at > datetime('now','-1 days')
    `).all();
    for (const dl of retry) {
      const rec = sweepAttempts.get(dl.id) || { at: 0, n: 0 };
      if (Date.now() - rec.at < 30 * 60 * 1000 || rec.n >= MAX_SWEEP_RETRIES) continue;
      sweepAttempts.set(dl.id, { at: Date.now(), n: rec.n + 1 });
      log.info(`sweep: re-searching #${dl.id} (${dl.label}) after a transient slskd outage`);
      setStatus(dl.id, 'searching', 'Retrying after slskd recovered');
      runSearch(dl.id);
    }
  }
}

/** On boot, resume polling for anything that was mid-flight. */
export function resumeOnBoot() {
  const stuck = db.prepare(`SELECT * FROM downloads WHERE status = 'searching'`).all();
  for (const dl of stuck) runSearch(dl.id);
  // Rebuild import plans for active transfers from Deezer.
  const active = db.prepare(`SELECT * FROM downloads WHERE status = 'downloading' AND slskd_user IS NOT NULL`).all();
  for (const dl of active) rebuildPlan(dl).catch(() => {});
}
