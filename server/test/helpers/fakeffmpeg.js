// Installs a stand-in for the ffmpeg binary (helpers/fake-ffmpeg.mjs), so the
// tagging code can be exercised end to end without ffmpeg: CI runners don't have
// it, and a real remux would make the suite depend on codec support.
//
// install() points FFMPEG_PATH at the fake and clears its call log; the fake
// records every argv it was given so tests can assert the exact command line.
// `mode` selects the failure being simulated ('ok', 'fail', 'failart',
// 'silent-fail', 'empty', 'hang').

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(here, 'fake-ffmpeg.mjs');
const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'musicarr-ffmpeg-')), 'calls.json');

// The exec bit travels in git, but a checkout with an unusual umask (or a
// Windows working copy) would leave it unset and spawn would fail confusingly.
fs.chmodSync(binPath, 0o755);

export function install(mode = 'ok') {
  process.env.FFMPEG_PATH = binPath;
  process.env.FAKE_FFMPEG_LOG = logPath;
  process.env.FAKE_FFMPEG_MODE = mode;
  fs.writeFileSync(logPath, '[]');
}

export function uninstall() {
  delete process.env.FFMPEG_PATH;
  delete process.env.FAKE_FFMPEG_LOG;
  delete process.env.FAKE_FFMPEG_MODE;
}

/** Every argv the fake was invoked with, oldest first. */
export function calls() {
  return fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
}

/** The `-metadata key=value` pairs of one recorded call, as an object. */
export function metaOf(argv) {
  const out = {};
  argv.forEach((a, i) => {
    if (a !== '-metadata') return;
    const kv = argv[i + 1] || '';
    const eq = kv.indexOf('=');
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
  });
  return out;
}
