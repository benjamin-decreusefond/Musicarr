// Retry bookkeeping: a candidate (peer + file/folder) gets PER_CANDIDATE_MAX
// transfer attempts before being excluded; the download gives up entirely
// after MAX_ATTEMPTS. Failure counts live in downloads.failed_candidates (a
// JSON map of "<user>|<file>" -> count) so retries survive restarts and stop
// re-picking peers that already failed twice.
export const PER_CANDIDATE_MAX = 2;
export const MAX_ATTEMPTS = 6;

export const candidateKey = (user, firstFile) => `${user}|${firstFile || ''}`;

export function failedCandidatesOf(dl) {
  try { const v = JSON.parse(dl.failed_candidates || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}

export function isExcluded(dl, user, firstFile) {
  return (failedCandidatesOf(dl)[candidateKey(user, firstFile)] || 0) >= PER_CANDIDATE_MAX;
}
