// Simple in-memory TTL cache with a size cap, shared by the external-API
// clients (Deezer, Jackett) to avoid hammering them and getting rate limited.
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
    if (map.size >= max) map.delete(map.keys().next().value); // evict oldest
    map.set(key, { at: Date.now(), val });
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

  return { get, set, wrap, get size() { return map.size; } };
}
