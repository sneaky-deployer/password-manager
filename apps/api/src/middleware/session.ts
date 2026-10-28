import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { type Db, getDb } from "../db/client.ts";
import { type Session, sessions, type User, users } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { AppError } from "../lib/errors.ts";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  sessionCookieName,
} from "../lib/sessions.ts";

// 32 random bytes as base64url. Anything else cannot be one of our tokens: skip the DB lookup.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface Auth {
  session: Session;
  user: User;
}

/**
 * Resolves a session token to its session and user, or null. A session is valid while: not past
 * `expires_at`, within 30 days idle (`last_seen_at`) and 90 days absolute (`created_at`), its
 * `security_stamp` equals the user's, and the user is `active`. Touches `last_seen_at` at most
 * once per hour.
 */
export async function resolveSession(
  db: Db,
  token: string,
  now = Date.now(),
): Promise<Auth | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, await sha256Hex(token)))
    .get();
  if (!row) return null;
  const { session, user } = row;
  if (
    session.expiresAt <= now ||
    now - session.createdAt >= SESSION_ABSOLUTE_MS ||
    now - session.lastSeenAt >= SESSION_IDLE_MS ||
    session.securityStamp !== user.securityStamp ||
    user.status !== "active"
  ) {
    return null;
  }
  if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
    session.lastSeenAt = now;
  }
  return { session, user };
}

/**
 * Non-blocking loader for `/api/*`: sets `c.var.session` and `c.var.user` when the cookie is a
 * valid session and leaves them undefined otherwise. It never rejects; use `requireAuth` for that.
 * Requires `loadConfig` to have run (cookie name depends on the environment).
 */
export const sessionLoader = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, sessionCookieName(c.var.config));
  if (token) {
    const auth = await resolveSession(getDb(c.env), token);
    if (auth) {
      c.set("session", auth.session);
      c.set("user", auth.user);
    }
  }
  await next();
});

/** 401 `unauthorized` unless a valid session was loaded. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.session || !c.var.user) throw new AppError("unauthorized", 401);
  await next();
});

/** 401 without a session, 403 `forbidden` unless the user's role is `admin`. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.session || !c.var.user) throw new AppError("unauthorized", 401);
  if (c.var.user.role !== "admin") throw new AppError("forbidden", 403);
  await next();
});

/** The authenticated session and user, typed non-optional. Throws 401 if absent (use after `requireAuth`). */
export function getAuth(c: Context<AppEnv>): Auth {
  const { session, user } = c.var;
  if (!session || !user) throw new AppError("unauthorized", 401);
  return { session, user };
}
