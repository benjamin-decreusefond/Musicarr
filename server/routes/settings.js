import fs from 'node:fs';
import path from 'node:path';
import { config, setSetting } from '../db.js';
import { requireAdmin } from '../auth.js';
import { testSlskd } from '../sources.js';
import { cleanupStaleTracks } from '../downloader.js';
export function registerSettings(api) {
/* -------------------------------------------------------------- Settings */
// Settings work like Radarr/Sonarr: edited from the UI, stored in the DB, and
// persisted across reboots. The matching env vars only seed first-run defaults.

// Current effective config (what the server is actually using right now).
function currentSettings() {
  // The slskd API key is a secret: never send it back to the browser. We only
  // report whether one is set (so the UI can show "configured") plus a short
  // masked hint of the tail for recognisability. Saving an empty value leaves
  // the stored key unchanged; sending a new value replaces it.
  const key = config.slskdApiKey || '';
  return {
    root_folder: config.musicDir,
    slskd_url: config.slskdUrl,
    slskd_api_key: '',
    slskd_api_key_set: !!key,
    slskd_api_key_hint: key ? `••••${key.slice(-4)}` : '',
    slskd_download_dir: config.slskdDownloadDir,
    slskd_enabled: config.slskdEnabled,
    cleanup_enabled: config.autoCleanupEnabled,
    cleanup_after_days: config.cleanupAfterDays,
    transcode_enabled: config.transcodeEnabled,
  };
}

api.get('/settings', requireAdmin, (req, res) => {
  res.json(currentSettings());
});

api.put('/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  const str = v => (v ?? '').toString().trim();
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  const isHttpUrl = v => /^https?:\/\/\S+$/i.test(v);

  try {
    // --- Library root folder (created and write-checked) ---
    if (has('root_folder')) {
      const folder = str(b.root_folder);
      if (!folder) throw new Error('Root folder is required');
      if (!path.isAbsolute(folder)) throw new Error('Root folder must be an absolute path (e.g. /music)');
      const resolved = path.resolve(folder);
      try {
        fs.mkdirSync(resolved, { recursive: true });
        fs.accessSync(resolved, fs.constants.W_OK);
      } catch (e) {
        throw new Error(`Root folder is not writable: ${e.message}`);
      }
      setSetting('root_folder', resolved);
    }

    // --- slskd (Soulseek) ---
    if (has('slskd_url')) {
      const url = str(b.slskd_url);
      if (url && !isHttpUrl(url)) throw new Error('slskd URL must start with http:// or https://');
      setSetting('slskd_url', url.replace(/\/$/, ''));
    }
    // The UI never receives the stored key back, so an empty value here means
    // "leave it as-is"; only a non-empty value replaces it. (Clearing the key is
    // done from the dedicated control that sends slskd_api_key_clear.)
    if (has('slskd_api_key') && str(b.slskd_api_key)) setSetting('slskd_api_key', str(b.slskd_api_key));
    if (b.slskd_api_key_clear === true) setSetting('slskd_api_key', '');
    if (has('slskd_download_dir')) {
      const dir = str(b.slskd_download_dir);
      if (dir && !path.isAbsolute(dir)) throw new Error('slskd download directory must be an absolute path');
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.accessSync(dir, fs.constants.R_OK);
        } catch (e) {
          throw new Error(`slskd download directory is not accessible from Musicarr: ${e.message}`);
        }
      }
      setSetting('slskd_download_dir', dir);
    }

    // --- Auto-cleanup (library maintenance) ---
    if (has('cleanup_enabled')) setSetting('cleanup_enabled', b.cleanup_enabled ? '1' : '0');
    if (has('cleanup_after_days')) {
      const n = parseInt(b.cleanup_after_days, 10);
      if (Number.isNaN(n) || n < 0) throw new Error('Cleanup period must be 0 or more days');
      setSetting('cleanup_after_days', String(n));
    }

    // --- Streaming: on-the-fly transcoding (needs ffmpeg on the server) ---
    if (has('transcode_enabled')) setSetting('transcode_enabled', b.transcode_enabled ? '1' : '0');
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  res.json(currentSettings());
});

// Run the stale-track cleanup immediately (admin), returning how many were removed.
api.post('/settings/cleanup-now', requireAdmin, async (req, res) => {
  try {
    const removed = await cleanupStaleTracks();
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Test a connection with the values being entered (before saving them).
api.post('/settings/test', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    if (b.section === 'slskd') {
      // Fall back to the stored URL/key when the form left them blank (the key is
      // never sent back to the browser, so "test" on an unchanged key must reuse it).
      const { serverState } = await testSlskd({
        url: (b.slskd_url || '').trim() || config.slskdUrl,
        apiKey: (b.slskd_api_key || '').trim() || config.slskdApiKey,
      });
      return res.json({ ok: true, detail: `Soulseek server: ${serverState}` });
    }
    return res.status(400).json({ error: 'Unknown section' });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

}
