// Reusable in-memory sliding-window rate limiter, used to keep a single user
// (or IP, before sign-in) from stampeding the expensive endpoints that fan out
// to Deezer/slskd. Per-process and best-effort — enough to blunt runaway
// clients without needing Redis. (Login has its own dedicated limiter in auth.js.)

export function rateLimit({ windowMs, max, maxKeys = 5000 } = {}) {
  const hits = new Map(); // key -> number[] (timestamps within the window)

  return function rateLimitMiddleware(req, res, next) {
    const key = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);

    // Bound memory: drop keys whose window has fully elapsed.
    if (hits.size > maxKeys) {
      for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    }

    if (recent.length > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down a moment' });
    }
    next();
  };
}
