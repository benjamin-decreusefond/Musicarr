#!/usr/bin/env node
// Stand-in for the ffmpeg binary used by the tagging tests: copies the first
// input to the output and records its argv, so the command line Musicarr builds
// can be asserted without ffmpeg (or codec support) being installed. Driven by
// FAKE_FFMPEG_LOG (where to record calls) and FAKE_FFMPEG_MODE (what to
// simulate). See helpers/fakeffmpeg.js.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const log = process.env.FAKE_FFMPEG_LOG;
const mode = process.env.FAKE_FFMPEG_MODE || 'ok';

const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
calls.push(argv);
fs.writeFileSync(log, JSON.stringify(calls));

const inputs = argv.map((a, i) => (a === '-i' ? argv[i + 1] : null)).filter(Boolean);
const dest = argv[argv.length - 1];

if (mode === 'fail') { process.stderr.write('Invalid data found when processing input\n'); process.exit(1); }
// Fail only when a cover was passed, so the art-less retry can be observed.
if (mode === 'failart' && inputs.length > 1) { process.stderr.write('attached_pic not supported\n'); process.exit(1); }
if (mode === 'silent-fail') process.exit(3);
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'empty') { fs.writeFileSync(dest, ''); process.exit(0); }
else { fs.copyFileSync(inputs[0], dest); process.exit(0); }
