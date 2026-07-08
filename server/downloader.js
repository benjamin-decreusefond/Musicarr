// Public API of the download pipeline. The implementation lives in
// ./download/*, split by stage:
//   search.js  — queueing, Soulseek search, candidate selection, cancel/retry
//   poller.js  — transfer polling, stall/failure handling, sweep, boot resume
//   import.js  — locating finished files and hardlinking them into the library
//   match.js   — pure verification rules (ISRC/duration/title matching)
//   library.js — disk reconciliation, deletion, auto-cleanup
//   peers.js   — peer strike blocklist
// Everything downstream (routes, releases watcher, tests) imports from here.
export { queueDownload, cancelDownloadTransfers, retryDownload } from './download/search.js';
export { startPoller, sweepUnimported, resumeOnBoot } from './download/poller.js';
export { recordPeerStrike, clearPeerStrikes, blockedPeers } from './download/peers.js';
export { cleanupStaleTracks, scanLibrary, deleteTrackFile, deleteTrackFiles } from './download/library.js';
