// Small helpers shared by the account routes: request parsing, failure-counting rate limits,
// deferred side effects and a few error helpers.
import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { type ZodType, z } from "zod";
import type { Db } from "../../db/client.ts";
import { rateLimits } from "../../db/schema.ts";
import type { AppEnv } from "../../env.ts";
import { clientIp } from "../../middleware/rate-limit.ts";
import { sha256Hex } from "../crypto.ts";
import { sendEmail } from "../email.ts";
import { type EmailContent, securityNoticeEmail } from "../email-templates.ts";
import { AppError, validationError } from "../errors.ts";
import { hitRateLimit } from "../rate-limit.ts";
import type { BatchStatement } from "./account-deletion.ts";

/** `400 challenge_invalid`: a 2FA/recovery/registration challenge is unknown, used or expired. */
export function challengeInvalid(message = "This request is invalid or has expired."): AppError {
  return new AppError("challenge_invalid", 400, message);
}

/** Parses the body of an endpoint that takes none: a missing/empty body counts as `{}`. */
export async function requireEmptyBody(c: Context<AppEnv>): Promise<void> {
  const text = (await c.req.text()).trim();
  let value: unknown = {};
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError("validation_error", 400, "Malformed JSON in request body");
    }
  }
  const result = z.strictObject({}).safeParse(value);
  if (!result.success) throw validationError(result.error);
}

/** Parses an optional JSON body with `schema` (missing/empty body counts as `{}`). */
export async function readOptionalJson<S extends ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  const text = (await c.req.text()).trim();
  let value: unknown = {};
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError("validation_error", 400, "Malformed JSON in request body");
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

// --- Rate limits --------------------------------------------------------------------------------

function throwRateLimited(c: Context<AppEnv>, retryAfterSeconds: number): never {
  c.header("Retry-After", String(retryAfterSeconds));
  throw new AppError("rate_limited", 429, undefined, { retryAfterSeconds });
}

/** Key part for an email: never put a raw email into a rate-limit key. */
export async function emailKey(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

export { clientIp };

/**
 * Throws 429 if `key` already has `limit` or more counted hits in its window. Does not count the
 * current request: pair it with `recordFailure` so only failed attempts burn the budget.
 */
export async function assertNotLimited(
  c: Context<AppEnv>,
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const row = await db
    .select({ count: rateLimits.count, windowStart: rateLimits.windowStart })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), gt(rateLimits.windowStart, now - windowMs)))
    .get();
  if (row && row.count >= limit) {
    throwRateLimited(c, Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000)));
  }
}

/** Counts one failed attempt against `key`. */
export async function recordFailure(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  await hitRateLimit(db, key, limit, windowSeconds);
}

/** Counts every call; throws 429 once more than `limit` calls hit `key` within the window. */
export async function hitOrThrow(
  c: Context<AppEnv>,
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await hitRateLimit(db, key, limit, windowSeconds);
  if (!result.allowed) throwRateLimited(c, result.retryAfterSeconds);
}

// --- Side effects -------------------------------------------------------------------------------

/**
 * Runs a side effect (usually sending an email) without letting its latency or failure change
 * the response. In production it runs after the response (`waitUntil`), which also keeps the
 * response time of "user exists" and "user does not exist" paths alike. Elsewhere it is awaited
 * so tests can read the dev outbox right after the request.
 */
export async function afterResponse(c: Context<AppEnv>, work: () => Promise<void>): Promise<void> {
  const safe = async () => {
    try {
      await work();
    } catch (error) {
      // Message only, never the email body or addresses.
      console.error(`deferred task failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };
  if (c.var.config.isProduction) {
    try {
      c.executionCtx.waitUntil(safe());
      return;
    } catch {
      // No execution context (should not happen in production): fall through and await.
    }
  }
  await safe();
}

/** Sends a plain email built from a template. Throws if the provider rejects it. */
export async function sendTemplate(
  c: Context<AppEnv>,
  to: string,
  content: EmailContent,
): Promise<void> {
  await sendEmail(c.env, { to, subject: content.subject, text: content.text });
}

/** Security notice email (fire and forget: a mail outage must not undo the security action). */
export async function sendSecurityNotice(
  c: Context<AppEnv>,
  to: string,
  event: string,
): Promise<void> {
  await afterResponse(c, () => sendTemplate(c, to, securityNoticeEmail({ event })));
}

export function userAgentOf(c: Context<AppEnv>): string | null {
  return c.req.header("User-Agent") ?? null;
}

/** `db.batch` needs a non-empty tuple; this runs a dynamically built list as one atomic batch. */
export async function runBatch(db: Db, statements: BatchStatement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (!first) return;
  await db.batch([first, ...rest]);
}
