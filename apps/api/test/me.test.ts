import {
  activityResponseSchema,
  apiErrorSchema,
  apiPaths,
  keyBundleSchema,
  listSessionsResponseSchema,
  loginOkResponseSchema,
  meResponseSchema,
  okResponseSchema,
  updateSettingsResponseSchema,
} from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  deletions,
  emailCodes,
  sessions,
  users,
  vaultMembers,
  vaults,
} from "../src/db/schema.ts";
import { getDevOutbox } from "../src/lib/email.ts";
import {
  createKnownUser,
  emailsTo,
  enableTotp,
  latestCode,
  loginAs,
  passwordMaterial,
} from "./account-test-utils.ts";
import {
  createClient,
  createTestSession,
  createUser,
  createVaultWithOwner,
  db,
  fakeBlob,
  readJson,
  resetDb,
} from "./helpers.ts";

const notices = (email: string) =>
  emailsTo(email).filter((message) => message.subject.startsWith("Security notice"));

async function sensitiveCode(client: ReturnType<typeof createClient>, email: string) {
  const res = await client.post(apiPaths.me.emailCode);
  expect(res.status).toBe(200);
  expect(okResponseSchema.parse(await readJson(res))).toEqual({ ok: true });
  return latestCode(email);
}

describe("GET /me and /me/keys", () => {
  beforeEach(resetDb);

  it("require a session", async () => {
    const anon = createClient();
    expect((await anon.get(apiPaths.me.root)).status).toBe(401);
    expect((await anon.get(apiPaths.me.keys)).status).toBe(401);
    expect((await anon.get(apiPaths.me.sessions)).status).toBe(401);
    expect((await anon.get(apiPaths.me.activity)).status).toBe(401);
  });

  it("return the profile and key bundle without verifiers", async () => {
    const known = await createKnownUser({ role: "admin" });
    const { client } = await loginAs(known);
    const meRes = await client.get(apiPaths.me.root);
    const me = meResponseSchema.parse(await readJson(meRes));
    expect(me.user).toMatchObject({
      id: known.user.id,
      email: known.user.email,
      role: "admin",
      twoFactor: { totp: false, webauthn: 0 },
      settings: { autoLockMinutes: 15, theme: "system" },
    });
    const keysRes = await client.get(apiPaths.me.keys);
    const keys = keyBundleSchema.parse(await readJson(keysRes));
    expect(keys.userId).toBe(known.user.id);
    expect(JSON.stringify([me, keys])).not.toContain(known.user.authVerifier);
    expect(JSON.stringify([me, keys])).not.toContain(known.user.recoveryVerifier);
  });
});

describe("change password (PLAN.md 10.4)", () => {
  beforeEach(resetDb);

  it("updates the material, signs other devices out and keeps this one signed in", async () => {
    const known = await createKnownUser();
    const { client: phone } = await loginAs(known);
    const { client: laptop } = await loginAs(known);

    const change = passwordMaterial();
    const res = await laptop.post(apiPaths.me.password, {
      currentAuthKey: known.authKey,
      ...change,
    });
    expect(res.status).toBe(200);
    expect(okResponseSchema.parse(await readJson(res))).toEqual({ ok: true });

    // New session cookie for this device, old devices are out.
    expect(res.headers.get("Set-Cookie")).toContain("pm_session=");
    expect((await laptop.get(apiPaths.me.root)).status).toBe(200);
    expect((await phone.get(apiPaths.me.root)).status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, known.user.id))).toHaveLength(
      1,
    );

    const row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row).toMatchObject({
      kdfSalt: change.newSalt,
      wrappedAkPw: change.newWrappedAk,
      securityStamp: known.user.securityStamp + 1,
    });
    // Nothing else about the keys changed (no item re-encryption, same recovery kit).
    expect(row?.wrappedAkRec).toBe(known.user.wrappedAkRec);
    expect(row?.encryptedPrivateKey).toBe(known.user.encryptedPrivateKey);

    // Old authKey fails, new one works; prelogin serves the new salt.
    const old = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(old.status).toBe(401);
    const fresh = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: change.newAuthKey,
    });
    expect(loginOkResponseSchema.parse(await readJson(fresh)).keys.salt).toBe(change.newSalt);

    expect(notices(known.user.email)).toHaveLength(1);
    const events = (
      await db.select().from(auditEvents).where(eq(auditEvents.userId, known.user.id))
    ).map((e) => e.event);
    expect(events).toContain("password_changed");
  });

  it("rejects a wrong current key and rate limits repeated failures", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    for (let i = 0; i < 10; i++) {
      const res = await client.post(apiPaths.me.password, {
        currentAuthKey: fakeBlob(32),
        ...passwordMaterial(),
      });
      expect(res.status).toBe(401);
      expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("invalid_credentials");
    }
    const blocked = await client.post(apiPaths.me.password, {
      currentAuthKey: known.authKey,
      ...passwordMaterial(),
    });
    expect(blocked.status).toBe(429);
    const row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row?.authVerifier).toBe(known.user.authVerifier);
  });

  it("validates the new material", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const res = await client.post(apiPaths.me.password, {
      currentAuthKey: known.authKey,
      ...passwordMaterial(),
      newKdf: { alg: "argon2id13", mem: 1024, ops: 1 },
    });
    expect(res.status).toBe(400);
  });
});

describe("reset from an unlocked device (PLAN.md 10.5 B)", () => {
  beforeEach(resetDb);

  it("needs a sensitive_action email code", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const code = await sensitiveCode(client, known.user.email);
    const change = passwordMaterial();

    const wrong = await client.post(apiPaths.me.passwordResetFromUnlocked, {
      emailCode: code === "000000" ? "111111" : "000000",
      ...change,
    });
    expect(wrong.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(wrong)).error.code).toBe("email_code_invalid");

    const ok = await client.post(apiPaths.me.passwordResetFromUnlocked, {
      emailCode: code,
      ...change,
    });
    expect(ok.status).toBe(200);
    expect((await client.get(apiPaths.me.root)).status).toBe(200);
    const login = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: change.newAuthKey,
    });
    expect(login.status).toBe(200);
    expect(notices(known.user.email)).toHaveLength(1);

    // The code works once.
    const again = await client.post(apiPaths.me.passwordResetFromUnlocked, {
      emailCode: code,
      ...passwordMaterial(),
    });
    expect(again.status).toBe(400);
  });

  it("does not accept a recovery or reset code", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    await createClient().post(apiPaths.auth.emailStart, {
      email: known.user.email,
      purpose: "recovery",
    });
    const code = latestCode(known.user.email);
    const res = await client.post(apiPaths.me.passwordResetFromUnlocked, {
      emailCode: code,
      ...passwordMaterial(),
    });
    expect(res.status).toBe(400);
  });

  it("limits sensitive codes to 5 per hour", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    for (let i = 0; i < 5; i++) expect((await client.post(apiPaths.me.emailCode)).status).toBe(200);
    expect((await client.post(apiPaths.me.emailCode)).status).toBe(429);
    expect(await db.select().from(emailCodes)).toHaveLength(5);
  });
});

describe("recovery kit and KDF upgrade", () => {
  beforeEach(resetDb);

  it("replaces the recovery kit: the new key recovers, the old one does not", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const kit = { wrappedAkRec: fakeBlob(72), recoveryAuthKey: fakeBlob(32) };
    const res = await client.post(apiPaths.me.recovery, kit);
    expect(res.status).toBe(200);
    expect(notices(known.user.email)).toHaveLength(1);

    const row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row?.wrappedAkRec).toBe(kit.wrappedAkRec);
    expect(row?.securityStamp).toBe(known.user.securityStamp); // sessions stay valid
    expect((await client.get(apiPaths.me.root)).status).toBe(200);

    const start = async (recoveryAuthKey: string) => {
      await createClient().post(apiPaths.auth.emailStart, {
        email: known.user.email,
        purpose: "recovery",
      });
      return createClient().post(apiPaths.auth.recoveryStart, {
        email: known.user.email,
        emailCode: latestCode(known.user.email),
        recoveryAuthKey,
      });
    };
    expect((await start(known.recoveryAuthKey)).status).toBe(401);
    expect((await start(kit.recoveryAuthKey)).status).toBe(200);
  });

  it("upgrades KDF parameters without signing other devices out", async () => {
    const known = await createKnownUser({ kdfMem: 32 * 1024 * 1024, kdfOps: 2 });
    const { client } = await loginAs(known);
    const { client: other } = await loginAs(known);
    const change = passwordMaterial();

    const res = await client.post(apiPaths.me.kdfUpgrade, {
      currentAuthKey: known.authKey,
      ...change,
    });
    expect(res.status).toBe(200);
    const row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row).toMatchObject({
      kdfMem: 64 * 1024 * 1024,
      kdfOps: 3,
      kdfSalt: change.newSalt,
      securityStamp: known.user.securityStamp,
    });
    expect((await other.get(apiPaths.me.root)).status).toBe(200);
    const login = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: change.newAuthKey,
    });
    expect(login.status).toBe(200);
  });

  it("refuses to weaken the KDF and checks the current key", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const weaker = await client.post(apiPaths.me.kdfUpgrade, {
      currentAuthKey: known.authKey,
      ...passwordMaterial(),
      newKdf: { alg: "argon2id13", mem: 32 * 1024 * 1024, ops: 3 },
    });
    expect(weaker.status).toBe(400);
    const wrong = await client.post(apiPaths.me.kdfUpgrade, {
      currentAuthKey: fakeBlob(32),
      ...passwordMaterial(),
    });
    expect(wrong.status).toBe(401);
  });
});

describe("sessions", () => {
  beforeEach(resetDb);

  it("lists sessions with the current one marked, and revokes others", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const other = await createTestSession(known.user, { userAgent: "Firefox" });
    const third = await createTestSession(known.user, { userAgent: "Safari" });
    const stranger = await createUser();
    const strangerSession = await createTestSession(stranger);

    const list = listSessionsResponseSchema.parse(
      await readJson(await client.get(apiPaths.me.sessions)),
    );
    expect(list.sessions).toHaveLength(3);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(list.sessions.find((s) => s.id === other.session.id)).toMatchObject({
      userAgent: "Firefox",
      current: false,
    });

    // Revoke one: that cookie stops working.
    const revoke = await client.delete(apiPaths.me.session(other.session.id));
    expect(revoke.status).toBe(200);
    const probe = createClient();
    probe.jar.set(other.cookieName, other.token);
    expect((await probe.get(apiPaths.me.root)).status).toBe(401);

    // Someone else's session is not found, and stays valid.
    const foreign = await client.delete(apiPaths.me.session(strangerSession.session.id));
    expect(foreign.status).toBe(404);
    expect(
      await db.select().from(sessions).where(eq(sessions.id, strangerSession.session.id)),
    ).toHaveLength(1);
    expect((await client.delete(apiPaths.me.session(crypto.randomUUID()))).status).toBe(404);
    expect((await client.delete(`${apiPaths.me.sessions}/not-a-uuid`)).status).toBe(400);

    // Revoke all others keeps the current session.
    const all = await client.delete(apiPaths.me.sessions);
    expect(all.status).toBe(200);
    const left = listSessionsResponseSchema.parse(
      await readJson(await client.get(apiPaths.me.sessions)),
    );
    expect(left.sessions).toHaveLength(1);
    expect(left.sessions[0]?.current).toBe(true);
    const thirdProbe = createClient();
    thirdProbe.jar.set(third.cookieName, third.token);
    expect((await thirdProbe.get(apiPaths.me.root)).status).toBe(401);
  });

  it("revoking the current session signs this device out", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const list = listSessionsResponseSchema.parse(
      await readJson(await client.get(apiPaths.me.sessions)),
    );
    const current = list.sessions.find((s) => s.current);
    const res = await client.delete(apiPaths.me.session(current?.id ?? ""));
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    expect((await client.get(apiPaths.me.root)).status).toBe(401);
  });
});

describe("settings and activity", () => {
  beforeEach(resetDb);

  it("merges partial settings and rejects invalid ones", async () => {
    const { client } = await loginAs(await createKnownUser());
    const res = await client.patch(apiPaths.me.settings, { theme: "dark" });
    expect(res.status).toBe(200);
    expect(updateSettingsResponseSchema.parse(await readJson(res)).settings).toEqual({
      autoLockMinutes: 15,
      theme: "dark",
    });
    const second = await client.patch(apiPaths.me.settings, { autoLockMinutes: 5 });
    expect(updateSettingsResponseSchema.parse(await readJson(second)).settings).toEqual({
      autoLockMinutes: 5,
      theme: "dark",
    });
    const me = meResponseSchema.parse(await readJson(await client.get(apiPaths.me.root)));
    expect(me.user.settings).toEqual({ autoLockMinutes: 5, theme: "dark" });

    expect((await client.patch(apiPaths.me.settings, {})).status).toBe(400);
    expect((await client.patch(apiPaths.me.settings, { theme: "neon" })).status).toBe(400);
    expect((await client.patch(apiPaths.me.settings, { autoLockMinutes: 0 })).status).toBe(400);
    expect((await client.patch(apiPaths.me.settings, { extra: 1 })).status).toBe(400);
  });

  it("pages through activity, newest first", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const base = Date.now() - 10_000;
    await db.insert(auditEvents).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: crypto.randomUUID(),
        userId: known.user.id,
        event: `test_event_${i}`,
        meta: JSON.stringify({ i }),
        createdAt: base + i * 1000,
      })),
    );
    const first = activityResponseSchema.parse(
      await readJson(await client.get(`${apiPaths.me.activity}?limit=3`)),
    );
    expect(first.events.map((e) => e.event)).toEqual(["login", "test_event_4", "test_event_3"]);
    expect(first.events[1]?.meta).toEqual({ i: 4 });
    const last = first.events[2];
    const second = activityResponseSchema.parse(
      await readJson(await client.get(`${apiPaths.me.activity}?limit=3&before=${last?.createdAt}`)),
    );
    expect(second.events.map((e) => e.event)).toEqual([
      "test_event_2",
      "test_event_1",
      "test_event_0",
    ]);
    expect((await client.get(`${apiPaths.me.activity}?limit=0`)).status).toBe(400);
    expect((await client.get(`${apiPaths.me.activity}?limit=101`)).status).toBe(400);
  });

  it("only shows the signed-in user's events", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const other = await createKnownUser();
    await loginAs(other);
    const events = activityResponseSchema.parse(
      await readJson(await client.get(apiPaths.me.activity)),
    );
    expect(events.events).toHaveLength(1);
  });

  it("never stores secrets in audit metadata", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const secrets: string[] = [known.authKey, known.recoveryAuthKey];

    const change = passwordMaterial();
    secrets.push(change.newAuthKey, change.newWrappedAk, change.newSalt);
    await client.post(apiPaths.me.password, { currentAuthKey: known.authKey, ...change });
    const kit = { wrappedAkRec: fakeBlob(72), recoveryAuthKey: fakeBlob(32) };
    secrets.push(kit.recoveryAuthKey, kit.wrappedAkRec);
    await client.post(apiPaths.me.recovery, kit);
    const { secret, backupCodes } = await enableTotp(client);
    secrets.push(secret, ...(backupCodes ?? []));
    const code = await sensitiveCode(client, known.user.email);
    secrets.push(code);
    await client.post(apiPaths.me.passwordResetFromUnlocked, {
      emailCode: code,
      ...passwordMaterial(),
    });

    const rows = await db.select().from(auditEvents);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      for (const secretValue of secrets) expect(row.meta).not.toContain(secretValue);
      for (const value of Object.values(JSON.parse(row.meta))) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
        expect(String(value).length).toBeLessThan(64);
      }
    }
  });
});

describe("delete account", () => {
  beforeEach(resetDb);

  it("needs the authKey and a sensitive_action code, then removes everything with tombstones", async () => {
    const known = await createKnownUser();
    const member = await createUser();
    const { client } = await loginAs(known);
    const { vault } = await createVaultWithOwner(known.user);
    const now = Date.now();
    await db.insert(vaultMembers).values({
      id: crypto.randomUUID(),
      vaultId: vault.id,
      userId: member.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: fakeBlob(80),
      status: "active",
      invitedBy: known.user.id,
      createdAt: now,
      updatedAt: now,
    });

    const code = await sensitiveCode(client, known.user.email);
    const wrongKey = await client.request("DELETE", apiPaths.me.root, {
      json: { currentAuthKey: fakeBlob(32), emailCode: code },
    });
    expect(wrongKey.status).toBe(401);
    const wrongCode = await client.request("DELETE", apiPaths.me.root, {
      json: { currentAuthKey: known.authKey, emailCode: code === "000000" ? "111111" : "000000" },
    });
    expect(wrongCode.status).toBe(400);
    expect(await db.select().from(users).where(eq(users.id, known.user.id))).toHaveLength(1);

    const res = await client.request("DELETE", apiPaths.me.root, {
      json: { currentAuthKey: known.authKey, emailCode: code },
    });
    expect(res.status).toBe(200);
    expect(okResponseSchema.parse(await readJson(res))).toEqual({ ok: true });
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    expect(await db.select().from(users).where(eq(users.id, known.user.id))).toHaveLength(0);
    expect(await db.select().from(vaults).where(eq(vaults.id, vault.id))).toHaveLength(0);
    const tombstones = await db.select().from(deletions);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ entity: "vault", entityId: vault.id, userId: member.id });
    expect((await client.get(apiPaths.me.root)).status).toBe(401);
    expect(getDevOutbox().length).toBeGreaterThan(0);
  });

  it("refuses to delete the last active admin", async () => {
    const known = await createKnownUser({ role: "admin" });
    const { client } = await loginAs(known);
    const code = await sensitiveCode(client, known.user.email);
    const res = await client.request("DELETE", apiPaths.me.root, {
      json: { currentAuthKey: known.authKey, emailCode: code },
    });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("last_admin");
    expect(await db.select().from(users).where(eq(users.id, known.user.id))).toHaveLength(1);

    // With a second active admin it is allowed.
    await createKnownUser({ role: "admin" });
    const ok = await client.request("DELETE", apiPaths.me.root, {
      json: { currentAuthKey: known.authKey, emailCode: code },
    });
    expect(ok.status).toBe(200);
  });
});
