import {
  apiErrorSchema,
  apiPaths,
  loginResponseSchema,
  meResponseSchema,
  okResponseSchema,
  preloginResponseSchema,
  twoFactorRequiredResponseSchema,
} from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditEvents, authChallenges, sessions, users } from "../src/db/schema.ts";
import { fakeSalt } from "../src/lib/crypto.ts";
import { getDevOutbox } from "../src/lib/email.ts";
import { config, createKnownUser, enableTotp, loginAs } from "./account-test-utils.ts";
import { createClient, db, fakeBlob, readJson, resetDb, signedInClient } from "./helpers.ts";

describe("prelogin", () => {
  beforeEach(resetDb);

  it("returns the stored salt and KDF params for a known email", async () => {
    const { user } = await createKnownUser({ kdfMem: 32 * 1024 * 1024, kdfOps: 4 });
    const res = await createClient().post(apiPaths.auth.prelogin, { email: user.email });
    expect(res.status).toBe(200);
    expect(preloginResponseSchema.parse(await readJson(res))).toEqual({
      kdf: { alg: "argon2id13", mem: 32 * 1024 * 1024, ops: 4 },
      salt: user.kdfSalt,
    });
  });

  it("returns a deterministic fake salt of the same shape for unknown emails", async () => {
    const client = createClient();
    const ask = async (email: string) =>
      preloginResponseSchema.parse(
        await readJson(await client.post(apiPaths.auth.prelogin, { email })),
      );
    const a1 = await ask("nobody@example.test");
    const a2 = await ask("  NoBody@Example.test ");
    const b = await ask("other@example.test");
    expect(a1).toEqual(a2);
    expect(a1.salt).not.toBe(b.salt);
    expect(a1.salt).toBe(await fakeSalt(config().fakeSaltKey, "nobody@example.test"));
    expect(a1.kdf).toEqual({ alg: "argon2id13", mem: 67108864, ops: 3 });

    // Same key set and value types as a real answer.
    const { user } = await createKnownUser();
    const real = await ask(user.email);
    expect(Object.keys(real).sort()).toEqual(Object.keys(a1).sort());
    expect(Object.keys(real.kdf).sort()).toEqual(Object.keys(a1.kdf).sort());
    expect(real.salt).toHaveLength(a1.salt.length);
  });
});

describe("login (PLAN.md 10.2)", () => {
  beforeEach(resetDb);

  it("signs in with the right authKey and returns the profile and key bundle", async () => {
    const known = await createKnownUser();
    const client = createClient();
    const res = await client.post(apiPaths.auth.login, {
      email: known.user.email.toUpperCase(),
      authKey: known.authKey,
    });
    expect(res.status).toBe(200);
    const body = loginResponseSchema.parse(await readJson(res));
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.user).toMatchObject({ id: known.user.id, role: "user" });
    expect(body.keys).toMatchObject({
      userId: known.user.id,
      salt: known.user.kdfSalt,
      wrappedAkPw: known.user.wrappedAkPw,
    });
    // The response never carries verifiers.
    const text = JSON.stringify(body);
    expect(text).not.toContain(known.user.authVerifier);
    expect(text).not.toContain(known.user.recoveryVerifier);

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("pm_session=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    // The cookie is a working session; only its hash is stored.
    const me = meResponseSchema.parse(await readJson(await client.get(apiPaths.me.root)));
    expect(me.user.id).toBe(known.user.id);
    const stored = await db.select().from(sessions).where(eq(sessions.userId, known.user.id));
    expect(stored).toHaveLength(1);
    expect(cookie).not.toContain(stored[0]?.tokenHash ?? "-");

    const refreshed = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(refreshed?.lastLoginAt).toBeGreaterThan(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.userId, known.user.id));
    expect(events.map((e) => e.event)).toEqual(["login"]);
    expect(JSON.parse(events[0]?.meta ?? "{}")).toEqual({ method: "password" });
  });

  it("answers 401 invalid_credentials the same way for wrong keys and unknown emails", async () => {
    const known = await createKnownUser();
    const client = createClient();
    const wrong = await client.post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: fakeBlob(32),
    });
    const unknown = await client.post(apiPaths.auth.login, {
      email: "nobody@example.test",
      authKey: fakeBlob(32),
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = apiErrorSchema.parse(await readJson(wrong));
    const b = apiErrorSchema.parse(await readJson(unknown));
    expect(a).toEqual(b);
    expect(a.error.code).toBe("invalid_credentials");
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("rate limits failures per email: 10 failures, then 429 even for the right key", async () => {
    const known = await createKnownUser();
    const client = createClient();
    for (let i = 0; i < 10; i++) {
      const res = await client.post(apiPaths.auth.login, {
        email: known.user.email,
        authKey: fakeBlob(32),
      });
      expect(res.status).toBe(401);
    }
    const blocked = await client.post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(blocked.status).toBe(429);
    expect(apiErrorSchema.parse(await readJson(blocked)).error.code).toBe("rate_limited");
    expect(blocked.headers.get("Retry-After")).toBeTruthy();

    // Another email is not affected (the IP budget is 30).
    const other = await createKnownUser();
    const ok = await client.post(apiPaths.auth.login, {
      email: other.user.email,
      authKey: other.authKey,
    });
    expect(ok.status).toBe(200);
  });

  it("rate limits failures per IP: 30 failures, then 429", async () => {
    const client = createClient();
    for (let i = 0; i < 30; i++) {
      const res = await client.post(apiPaths.auth.login, {
        email: `ghost${i}@example.test`,
        authKey: fakeBlob(32),
      });
      expect(res.status).toBe(401);
    }
    const known = await createKnownUser();
    const res = await client.post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(res.status).toBe(429);
  });

  it("successful logins do not consume the failure budget", async () => {
    const known = await createKnownUser();
    for (let i = 0; i < 12; i++) {
      const res = await createClient().post(apiPaths.auth.login, {
        email: known.user.email,
        authKey: known.authKey,
      });
      expect(res.status).toBe(200);
    }
  });

  it("refuses a disabled account with 403 account_disabled only after a correct key", async () => {
    const known = await createKnownUser({ status: "disabled" });
    const client = createClient();
    const good = await client.post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(good.status).toBe(403);
    expect(apiErrorSchema.parse(await readJson(good)).error.code).toBe("account_disabled");
    expect(good.headers.get("Set-Cookie")).toBeNull();

    const bad = await client.post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: fakeBlob(32),
    });
    expect(bad.status).toBe(401);
    expect(apiErrorSchema.parse(await readJson(bad)).error.code).toBe("invalid_credentials");
  });

  it("asks for a second factor when 2FA is enabled and stores only the token hash", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { backupCodes } = await enableTotp(client);
    expect(backupCodes).toHaveLength(10);

    const fresh = createClient();
    const res = await fresh.post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const body = twoFactorRequiredResponseSchema.parse(await readJson(res));
    expect(body.methods).toEqual(["totp", "backup_code"]);

    const rows = await db.select().from(authChallenges).where(eq(authChallenges.kind, "2fa"));
    expect(rows.map((row) => row.tokenHash)).not.toContain(body.challengeToken);
    const live = rows.find((row) => JSON.parse(row.payload).purpose === "login");
    expect(live?.expiresAt).toBeGreaterThan(Date.now());
    expect(live?.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
  });
});

describe("logout", () => {
  beforeEach(resetDb);

  it("ends the session and clears the cookie", async () => {
    const { client, user } = await signedInClient();
    const res = await client.post(apiPaths.auth.logout);
    expect(res.status).toBe(200);
    expect(okResponseSchema.parse(await readJson(res))).toEqual({ ok: true });
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    expect((await client.get(apiPaths.me.root)).status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  it("is harmless without a session", async () => {
    const res = await createClient().post(apiPaths.auth.logout);
    expect(res.status).toBe(200);
  });
});

describe("email codes for signed-out flows", () => {
  beforeEach(resetDb);

  it("answers identically for known and unknown emails and mails only the real account", async () => {
    const known = await createKnownUser();
    const client = createClient();
    const real = await client.post(apiPaths.auth.emailStart, {
      email: known.user.email,
      purpose: "recovery",
    });
    const ghost = await client.post(apiPaths.auth.emailStart, {
      email: "ghost@example.test",
      purpose: "recovery",
    });
    expect(real.status).toBe(200);
    expect(ghost.status).toBe(200);
    expect(await readJson(real)).toEqual(await readJson(ghost));
    const outbox = getDevOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(known.user.email);
    expect(outbox[0]?.text).toMatch(/\b\d{6}\b/);
  });

  it("does not mail disabled accounts", async () => {
    const known = await createKnownUser({ status: "disabled" });
    const res = await createClient().post(apiPaths.auth.emailStart, {
      email: known.user.email,
      purpose: "reset_account",
    });
    expect(res.status).toBe(200);
    expect(getDevOutbox()).toHaveLength(0);
  });

  it("limits to 5 codes per hour per email", async () => {
    const known = await createKnownUser();
    const client = createClient();
    for (let i = 0; i < 5; i++) {
      const res = await client.post(apiPaths.auth.emailStart, {
        email: known.user.email,
        purpose: "recovery",
      });
      expect(res.status).toBe(200);
    }
    const res = await client.post(apiPaths.auth.emailStart, {
      email: known.user.email,
      purpose: "recovery",
    });
    expect(res.status).toBe(429);
    // The unknown-email path is limited identically, so the limit is no oracle either.
    for (let i = 0; i < 5; i++) {
      await client.post(apiPaths.auth.emailStart, { email: "g@example.test", purpose: "recovery" });
    }
    const ghost = await client.post(apiPaths.auth.emailStart, {
      email: "g@example.test",
      purpose: "recovery",
    });
    expect(ghost.status).toBe(429);
  });

  it("rejects purposes that need a session", async () => {
    const res = await createClient().post(apiPaths.auth.emailStart, {
      email: "a@example.test",
      purpose: "sensitive_action",
    });
    expect(res.status).toBe(400);
  });
});
