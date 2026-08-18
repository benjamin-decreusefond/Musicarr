// Simple in-memory TTL cache with a size cap, used by the external-API
// clients (Deezer) to avoid hammering them and getting rate limited.
export function createCache({ ttlMs, max = 500 }) {
  const map = new Map(); // key -> { at, val }

  function get(key) {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= ttlMs) { map.delete(key); return undefined; }
    // Refresh LRU position.
    map.delete(key); map.set(key, hit);
    return hit.val;
  }

  function set(key, val) {
    const now = Date.now();
    if (map.size >= max) {
      // Reclaim entries whose TTL has already elapsed before falling back to
      // evicting a live one — `get` only expires keys that are actually read,
      // so a cache filled with stale-but-untouched entries would otherwise keep
      // dropping fresh ones to stay under `max`.
      for (const [k, v] of map) {
        if (now - v.at >= ttlMs) map.delete(k);
      }
      if (map.size >= max) map.delete(map.keys().next().value); // evict oldest
    }
    map.set(key, { at: now, val });
  }

  // De-dupes concurrent misses for the same key so a burst of identical
  // requests results in a single upstream call.
  const inflight = new Map();
  async function wrap(key, fn) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try { const v = await fn(); set(key, v); return v; }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }

  /** Drop everything. Used when a setting invalidates what was cached, and by
   *  tests that need a cold cache between cases. */
  function clear() { map.clear(); inflight.clear(); }

  return { get, set, wrap, clear, get size() { return map.size; } };
}
