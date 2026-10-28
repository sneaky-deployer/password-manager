import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NewSession, sessions, type User, users } from "../db/schema.ts";
import type { Config } from "../env.ts";
import { newId, randomToken, sha256Hex } from "./crypto.ts";

// PLAN.md 10.2: idle expiry 30 days, absolute expiry 90 days.
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often per session (no write per request). */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const USER_AGENT_MAX = 255;

/**
 * Cookie name. Production: `__Host-pm_session` (bound to the exact host, needs Secure + Path=/).
 * Development and tests: plain `pm_session` without Secure, because `__Host-` cookies require
 * Secure and local development runs over http://localhost (Safari rejects Secure cookies there).
 * Only the name and the Secure attribute differ; everything else is identical.
 */
export function sessionCookieName(config: Pick<Config, "isProduction">): string {
  return config.isProduction ? "__Host-pm_session" : "pm_session";
}

function cookie(
  config: Pick<Config, "isProduction">,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${sessionCookieName(config)}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (config.isProduction) parts.push("Secure");
  return parts.join("; ");
}

/** `Set-Cookie` header value for a new session (HttpOnly, SameSite=Strict, Path=/, Max-Age 90 d). */
export function serializeSessionCookie(
  config: Pick<Config, "isProduction">,
  token: string,
): string {
  return cookie(config, token, SESSION_ABSOLUTE_MS / 1000);
}

/** `Set-Cookie` header value that removes the session cookie. */
export function clearSessionCookie(config: Pick<Config, "isProduction">): string {
  return cookie(config, "", 0);
}

export interface PreparedSession {
  /** The raw token (only ever in the cookie; the DB stores its SHA-256). */
  token: string;
  /** Value for a `Set-Cookie` response header: `c.header("Set-Cookie", cookie, { append: true })`. */
  cookie: string;
  row: NewSession & { id: string };
  /** The un-awaited insert, for use inside `db.batch([...])` (e.g. account creation). */
  insert: ReturnType<ReturnType<Db["insert"]>["values"]>;
}

/**
 * Builds a session for `user` without writing it, so it can join an atomic `db.batch`. The session
 * is stamped with `user.securityStamp`; pass the NEW stamp when the same batch bumps it.
 */
export async function prepareSession(
  db: Db,
  config: Config,
  user: Pick<User, "id" | "securityStamp">,
  userAgent: string | null | undefined,
  now = Date.now(),
): Promise<PreparedSession> {
  const token = randomToken(32);
  const row = {
    id: newId(),
    userId: user.id,
    tokenHash: await sha256Hex(token),
    securityStamp: user.securityStamp,
    userAgent: (userAgent ?? "").slice(0, USER_AGENT_MAX),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_ABSOLUTE_MS,
  };
  return {
    token,
    cookie: serializeSessionCookie(config, token),
    row,
    insert: db.insert(sessions).values(row),
  };
}

/** Creates and stores a session. Returns the token and the `Set-Cookie` value. */
export async function createSession(
  db: Db,
  config: Config,
  user: Pick<User, "id" | "securityStamp">,
  userAgent: string | null | undefined,
  now = Date.now(),
): Promise<PreparedSession> {
  const prepared = await prepareSession(db, config, user, userAgent, now);
  await prepared.insert;
  return prepared;
}

/** Deletes one session (logout, revoke). */
export async function destroySession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Un-awaited delete of all of a user's sessions, optionally keeping one, for `db.batch`. */
export function destroyAllSessionsStatement(db: Db, userId: string, exceptSessionId?: string) {
  return db
    .delete(sessions)
    .where(
      exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId),
    );
}

/** Deletes all of a user's sessions (optionally keeping the current one). */
export async function destroyAllSessions(
  db: Db,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await destroyAllSessionsStatement(db, userId, exceptSessionId);
}

/**
 * Un-awaited `security_stamp = security_stamp + 1` for `db.batch`. Every session stamped with the
 * old value stops working immediately. Remember to stamp a replacement session with the new value
 * (`user.securityStamp + 1`).
 */
export function bumpSecurityStampStatement(db: Db, userId: string, now = Date.now()) {
  return db
    .update(users)
    .set({ securityStamp: sql`${users.securityStamp} + 1`, updatedAt: now })
    .where(eq(users.id, userId));
}

/** Bumps the stamp (logs out every device, including this one). */
export async function bumpSecurityStamp(db: Db, userId: string, now = Date.now()): Promise<void> {
  await bumpSecurityStampStatement(db, userId, now);
}
