/**
 * middleware/rateLimit.js
 * Minimal in-memory rate limiter — no extra dependency, good enough for a
 * single-instance Render deployment. If you scale to multiple instances,
 * swap this for a Redis-backed limiter (the interface stays the same).
 */
'use strict';

const _buckets = new Map(); // key -> [timestamps]

function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    const arr = (_buckets.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    arr.push(now);
    _buckets.set(key, arr);
    next();
  };
}

// Periodic cleanup so the Map doesn't grow unbounded over a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of _buckets.entries()) {
    const fresh = arr.filter(t => now - t < 15 * 60 * 1000);
    if (fresh.length === 0) _buckets.delete(key);
    else _buckets.set(key, fresh);
  }
}, 5 * 60 * 1000).unref();

module.exports = { rateLimit };
