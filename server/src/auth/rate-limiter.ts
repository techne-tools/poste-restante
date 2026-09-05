/**
 * In-memory sliding-window rate limiter for sensitive authentication doors.
 * Enforces presence-not-pressure defensively: throttles high-frequency brute-force attempts.
 */
import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  code?: string;
  keyGenerator?: (c: Parameters<MiddlewareHandler>[0]) => string;
}

export function createRateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const {
    windowMs,
    max,
    message = "the house asks you to wait a moment — too many attempts",
    code = "rate_limited",
    keyGenerator = (c) =>
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1",
  } = options;

  const hits = new Map<string, { count: number; resetAt: number }>();

  // Cleanup interval runs periodically to avoid unbounded memory accumulation
  const cleanupMs = Math.max(windowMs, 60_000);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }, cleanupMs);
  timer.unref?.();

  return async (c, next) => {
    const key = keyGenerator(c);
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + windowMs };
      hits.set(key, entry);
    } else {
      entry.count++;
    }

    if (entry.count > max) {
      return c.json(
        { error: { code, message } },
        429,
      );
    }

    await next();
  };
}
