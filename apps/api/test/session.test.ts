import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { sessions, users } from "../src/db/schema.ts";
import type { AppEnv } from "../src/env.ts";
import { getConfig } from "../src/env.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { errorHandler } from "../src/lib/errors.ts";
import {
  bumpSecurityStamp,
  clearSessionCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  serializeSessionCookie,
  sessionCookieName,
} from "../src/lib/sessions.ts";
import { loadConfig } from "../src/middleware/config.ts";
import { getAuth, requireAdmin, requireAuth, sessionLoader } from "../src/middleware/session.ts";
import { createTestSession, createUser, db, resetDb } from "./helpers.ts";

// A tiny test-only app with the same middleware order as app.ts.
const testApp = new Hono<AppEnv>()
  .use(loadConfig, sessionLoader)
  .get("/whoami", requireAuth, (c) =>
    c.json({ id: getAuth(c).user.id, sessionId: getAuth(c).session.id }),
  )
  .get("/admin", requireAdmin, (c) => c.json({ ok: true }))
  .get("/optional", (c) => c.json({ id: c.var.user?.id ?? null }))
  .onError(errorHandler);

function get(path: string, cookie?: string) {
  return testApp.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env);
}

describe("session loader", () => {
  beforeEach(resetDb);

  it("loads the user for a valid cookie", async () => {
    const user = await createUser();
    const { cookie, session } = await createTestSession(user);
    const res = await get("/whoami", cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: user.id, sessionId: session.id });
  });

  it("is non-blocking: no cookie, a garbage cookie and an unknown token all pass through unauthenticated", async () => {
    const name = sessionCookieName(getConfig(env));
    expect(await (await get("/optional")).json()).toEqual({ id: null });
    expect(await (await get("/optional", `${name}=garbage`)).json()).toEqual({ id: null });
    expect(await (await get("/optional", `${name}=${"a".repeat(43)}`)).json()).toEqual({
      id: null,
    });
  });

  it("requireAuth answers 401 unauthorized without a session", async () => {
    const res = await get("/whoami");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("rejects a session idle for 30 days", async () => {
    const user = await createUser();
    const now = Date.now();
    const { cookie } = await createTestSession(user, {
      createdAt: now - 40 * 86_400_000,
      lastSeenAt: now - SESSION_IDLE_MS - 1000,
    });
    expect((await get("/whoami", cookie)).status).toBe(401);
  });

  it("accepts a session idle for just under 30 days", async () => {
    const user = await createUser();
    const now = Date.now();
    const { cookie } = await createTestSession(user, {
      createdAt: now - 40 * 86_400_000,
      lastSeenAt: now - SESSION_IDLE_MS + 60_000,
    });
    expect((await get("/whoami", cookie)).status).toBe(200);
  });

  it("rejects a session older than 90 days even if it was used a minute ago", async () => {
    const user = await createUser();
    const now = Date.now();
    const { cookie } = await createTestSession(user, {
      createdAt: now - SESSION_ABSOLUTE_MS - 1000,
      lastSeenAt: now - 60_000,
      expiresAt: now + 86_400_000, // even a wrong expires_at must not extend the absolute limit
    });
    expect((await get("/whoami", cookie)).status).toBe(401);
  });

  it("rejects a session past expires_at", async () => {
    const user = await createUser();
    const { cookie } = await createTestSession(user, { expiresAt: Date.now() - 1 });
    expect((await get("/whoami", cookie)).status).toBe(401);
  });

  it("rejects a session whose security_stamp no longer matches the user's", async () => {
    const user = await createUser();
    const { cookie } = await createTestSession(user);
    expect((await get("/whoami", cookie)).status).toBe(200);
    await bumpSecurityStamp(db, user.id);
    expect((await get("/whoami", cookie)).status).toBe(401);
  });

  it("rejects a session stamped with an older stamp", async () => {
    const user = await createUser({ securityStamp: 5 });
    const { cookie } = await createTestSession(user, { securityStamp: 4 });
    expect((await get("/whoami", cookie)).status).toBe(401);
  });

  it("rejects sessions of disabled users", async () => {
    const user = await createUser();
    const { cookie } = await createTestSession(user);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    expect((await get("/whoami", cookie)).status).toBe(401);
  });

  it("requireAdmin: 401 without session, 403 for users, 200 for admins", async () => {
    const regular = await createUser({ role: "user" });
    const admin = await createUser({ role: "admin" });
    expect((await get("/admin")).status).toBe(401);
    const forbidden = await get("/admin", (await createTestSession(regular)).cookie);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await get("/admin", (await createTestSession(admin)).cookie)).status).toBe(200);
  });

  it("touches last_seen_at at most once per hour", async () => {
    const user = await createUser();
    const now = Date.now();
    const fresh = await createTestSession(user, {
      createdAt: now - 1000,
      lastSeenAt: now - 60_000,
    });
    await get("/whoami", fresh.cookie);
    const [unchanged] = await db.select().from(sessions).where(eq(sessions.id, fresh.session.id));
    expect(unchanged?.lastSeenAt).toBe(fresh.session.lastSeenAt);

    const stale = await createTestSession(user, {
      createdAt: now - 5 * 86_400_000,
      lastSeenAt: now - SESSION_TOUCH_INTERVAL_MS - 60_000,
    });
    await get("/whoami", stale.cookie);
    const [touched] = await db.select().from(sessions).where(eq(sessions.id, stale.session.id));
    expect(touched?.lastSeenAt).toBeGreaterThanOrEqual(now);
  });
});

describe("session helpers", () => {
  beforeEach(resetDb);
  const config = () => getConfig(env);

  it("createSession stores only the token hash and returns a working cookie", async () => {
    const user = await createUser();
    const { token, cookie, row } = await createSession(db, config(), user, "Mozilla/5.0 test");
    expect(token).toHaveLength(43);
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, row.id));
    expect(stored?.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.userAgent).toBe("Mozilla/5.0 test");
    expect(stored?.securityStamp).toBe(user.securityStamp);
    expect(stored?.expiresAt).toBe(stored ? stored.createdAt + SESSION_ABSOLUTE_MS : 0);
    expect((await get("/whoami", cookie.split(";")[0])).status).toBe(200);
  });

  it("destroySession and destroyAllSessions delete rows (optionally keeping one)", async () => {
    const user = await createUser();
    const a = await createTestSession(user);
    const b = await createTestSession(user);
    const c = await createTestSession(user);
    await destroySession(db, a.session.id);
    expect(await db.select().from(sessions)).toHaveLength(2);
    await destroyAllSessions(db, user.id, c.session.id);
    const remaining = await db.select().from(sessions);
    expect(remaining.map((s) => s.id)).toEqual([c.session.id]);
    expect(b.session.id).not.toBe(c.session.id);
  });

  it("bumpSecurityStamp increments the stamp", async () => {
    const user = await createUser();
    await bumpSecurityStamp(db, user.id);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after?.securityStamp).toBe(user.securityStamp + 1);
  });

  it("serializes the cookie per environment", () => {
    const production = serializeSessionCookie({ isProduction: true }, "tok");
    expect(production).toBe(
      "__Host-pm_session=tok; Path=/; Max-Age=7776000; HttpOnly; SameSite=Strict; Secure",
    );
    const dev = serializeSessionCookie({ isProduction: false }, "tok");
    expect(dev).toBe("pm_session=tok; Path=/; Max-Age=7776000; HttpOnly; SameSite=Strict");
    expect(dev).not.toContain("Secure");
    expect(clearSessionCookie({ isProduction: true })).toContain("Max-Age=0");
    expect(clearSessionCookie({ isProduction: true })).toMatch(/^__Host-pm_session=;/);
  });
});
