import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env.ts";
import { errorHandler } from "../src/lib/errors.ts";
import { hitRateLimit } from "../src/lib/rate-limit.ts";
import { loadConfig } from "../src/middleware/config.ts";
import { rateLimit } from "../src/middleware/rate-limit.ts";
import { db, resetDb } from "./helpers.ts";

const testApp = new Hono<AppEnv>()
  .use(loadConfig)
  .post(
    "/limited",
    rateLimit({
      key: (c) => `test:${c.req.header("X-Bucket") ?? "default"}`,
      limit: 3,
      windowSeconds: 60,
    }),
    (c) => c.json({ ok: true }),
  )
  .onError(errorHandler);

function hit(bucket = "default") {
  return testApp.request("/limited", { method: "POST", headers: { "X-Bucket": bucket } }, env);
}

describe("rateLimit", () => {
  beforeEach(resetDb);

  it("answers 429 rate_limited with Retry-After after the limit", async () => {
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    const res = await hit();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await hit()).status).toBe(429);
  });

  it("keeps separate counters per key", async () => {
    for (let i = 0; i < 4; i++) await hit("a");
    expect((await hit("a")).status).toBe(429);
    expect((await hit("b")).status).toBe(200);
  });
});

describe("hitRateLimit", () => {
  beforeEach(resetDb);

  it("counts within a window and resets after it", async () => {
    const t0 = 1_000_000;
    const first = await hitRateLimit(db, "k", 2, 60, t0);
    expect(first).toMatchObject({ allowed: true, count: 1, retryAfterSeconds: 60 });
    expect((await hitRateLimit(db, "k", 2, 60, t0 + 10_000)).allowed).toBe(true);
    const third = await hitRateLimit(db, "k", 2, 60, t0 + 20_000);
    expect(third).toMatchObject({ allowed: false, count: 3, retryAfterSeconds: 40 });

    // Window is over: the counter starts again.
    const later = await hitRateLimit(db, "k", 2, 60, t0 + 60_000);
    expect(later).toMatchObject({ allowed: true, count: 1, retryAfterSeconds: 60 });
  });

  it("is atomic under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => hitRateLimit(db, "burst", 5, 60)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(Math.max(...results.map((r) => r.count))).toBe(10);
  });
});
