import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client.ts";
import type { AppEnv } from "../env.ts";
import { errorBody } from "../lib/errors.ts";
import { hitRateLimit } from "../lib/rate-limit.ts";

/** Client IP as seen by Cloudflare. Falls back to a shared bucket if the header is absent. */
export function clientIp(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

export interface RateLimitOptions {
  /**
   * Bucket key, namespaced by you, e.g. `` `login:ip:${clientIp(c)}` ``. For emails or other
   * personal data, hash first: `` `login:email:${await sha256Hex(email)}` ``. May be async.
   */
  key: (c: Context<AppEnv>) => string | Promise<string>;
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed-window limiter backed by the `rate_limits` table. Responds 429 `rate_limited` with a
 * `Retry-After` header once more than `limit` requests hit the same key in `windowSeconds`.
 * Every request counts. To count only failures, call `hitRateLimit` from `lib/rate-limit.ts`.
 */
export function rateLimit(options: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = await options.key(c);
    const result = await hitRateLimit(getDb(c.env), key, options.limit, options.windowSeconds);
    if (!result.allowed) {
      return c.json(errorBody("rate_limited"), 429, {
        "Retry-After": String(result.retryAfterSeconds),
      });
    }
    await next();
  });
}
