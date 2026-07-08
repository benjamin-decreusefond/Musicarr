// Peer blocklist: Soulseek peers that keep failing (stalls, rejects, wrong
// files) stop being picked as candidates for a while. Strikes are shared
// across downloads; a successful import from a peer clears its slate, and
// strikes age out after the window.
import { db } from '../db.js';

const PEER_BLOCK_STRIKES = 5;
const PEER_BLOCK_WINDOW = '-7 days';

export function recordPeerStrike(username) {
  if (!username) return;
  db.prepare(`
    INSERT INTO peer_strikes (username, strikes, last_strike) VALUES (?, 1, datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      strikes = CASE WHEN last_strike < datetime('now', ?) THEN 1 ELSE strikes + 1 END,
      last_strike = datetime('now')
  `).run(username, PEER_BLOCK_WINDOW);
}

export function clearPeerStrikes(username) {
  if (username) db.prepare('DELETE FROM peer_strikes WHERE username = ?').run(username);
}

/** Peers currently over the strike threshold (also shown on the health page). */
export function blockedPeers() {
  return db.prepare(`
    SELECT username, strikes, last_strike FROM peer_strikes
    WHERE strikes >= ? AND last_strike > datetime('now', ?)
    ORDER BY strikes DESC, username
  `).all(PEER_BLOCK_STRIKES, PEER_BLOCK_WINDOW);
}

export const blockedPeerSet = () => new Set(blockedPeers().map(p => p.username));
