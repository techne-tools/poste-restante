import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createRateLimiter } from "../../src/auth/rate-limiter.js";

describe("createRateLimiter", () => {
  it("allows requests under the limit and throttles when exceeded", async () => {
    const app = new Hono();
    app.use(
      "/test",
      createRateLimiter({
        windowMs: 10_000,
        max: 2,
        message: "too many requests",
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    // 1st request — allowed
    let res = await app.request("/test");
    expect(res.status).toBe(200);

    // 2nd request — allowed
    res = await app.request("/test");
    expect(res.status).toBe(200);

    // 3rd request — rate limited
    res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toBe("too many requests");
  });
});
