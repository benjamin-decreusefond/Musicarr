// Side-effect module: prepares a clean, isolated environment for a test file.
//
// IMPORTANT: this must be the FIRST import in every test file, before any
// `../../<module>.js` import. ESM evaluates imports in source order, so importing
// this first guarantees DATA_DIR / MUSIC_DIR / SLSKD_DOWNLOAD_DIR are set before
// db.js reads them at module-load time. Each test file runs in its own process
// (node --test isolation), so each gets a fresh temp data dir and its own SQLite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Capture the real fetch before any test installs a stub over globalThis.fetch,
// so the HTTP test client can reach our own app while the app's outbound calls
// (Deezer/slskd/LRCLIB) hit the stub.
export const realFetch = globalThis.fetch.bind(globalThis);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicarr-test-'));
export const dataDir = dir;
export const musicDir = path.join(dir, 'music');
export const downloadDir = path.join(dir, 'slskd-downloads');

process.env.DATA_DIR = dataDir;
process.env.MUSIC_DIR = musicDir;
process.env.SLSKD_DOWNLOAD_DIR = downloadDir;
// Keep test output quiet by default; the logger tests set their own level.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// Point the external metadata clients at hosts the fetch stub recognises.
process.env.DEEZER_URL = 'https://deezer.test';
process.env.LRCLIB_URL = 'https://lrclib.test';

fs.mkdirSync(musicDir, { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });
