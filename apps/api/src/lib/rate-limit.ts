import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { rateLimits } from "../db/schema.ts";

export interface RateLimitResult {
  allowed: boolean;
  /** Hits in the current window, including this one. */
  count: number;
  limit: number;
  /** Seconds until the current window ends (use for `Retry-After`). */
  retryAfterSeconds: number;
}

/**
 * Counts one hit against `key` in a fixed window and reports whether it is within `limit`.
 * One upsert statement, so concurrent requests cannot lose counts. A hit past the limit still
 * increments (harmless; the window resets on its own).
 *
 * Use the `rateLimit` middleware when every request should count. Call this directly when only
 * some outcomes count (e.g. failed logins). Keys are namespaced by the caller, e.g.
 * `login:email:<sha256Hex(email)>` or `login:ip:<ip>`: never put a raw email in a key.
 */
export async function hitRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const cutoff = now - windowMs;
  const expired = sql`${rateLimits.windowStart} <= ${cutoff}`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`CASE WHEN ${expired} THEN ${now} ELSE ${rateLimits.windowStart} END`,
        count: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimits.count} + 1 END`,
      },
    })
    .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });
  if (!row) throw new Error("rate limit upsert returned no row");
  return {
    allowed: row.count <= limit,
    count: row.count,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000)),
  };
}
