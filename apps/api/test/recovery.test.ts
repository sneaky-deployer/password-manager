import {
  apiErrorSchema,
  apiPaths,
  loginOkResponseSchema,
  recoveryCompleteResponseSchema,
  recoveryStartResponseSchema,
  resetAccountResponseSchema,
} from "@pm/shared";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  authChallenges,
  deletions,
  emailCodes,
  itemShares,
  items,
  sessions,
  users,
  vaultMembers,
  vaults,
} from "../src/db/schema.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import {
  accountMaterial,
  createKnownUser,
  emailsTo,
  enableTotp,
  type KnownUser,
  latestCode,
  loginAs,
  passwordMaterial,
  totpCode,
} from "./account-test-utils.ts";
import {
  createClient,
  createItem,
  createUser,
  createVaultWithOwner,
  db,
  fakeBlob,
  readJson,
  resetDb,
} from "./helpers.ts";

async function requestCode(email: string, purpose: "recovery" | "reset_account") {
  const res = await createClient().post(apiPaths.auth.emailStart, { email, purpose });
  expect(res.status).toBe(200);
  return latestCode(email);
}

async function startRecovery(
  known: KnownUser,
  extra: Record<string, unknown> = {},
  overrides: { emailCode?: string; recoveryAuthKey?: string } = {},
) {
  const emailCode = overrides.emailCode ?? (await requestCode(known.user.email, "recovery"));
  const res = await createClient().post(apiPaths.auth.recoveryStart, {
    email: known.user.email,
    emailCode,
    recoveryAuthKey: overrides.recoveryAuthKey ?? known.recoveryAuthKey,
    ...extra,
  });
  return { res, emailCode };
}

describe("recovery kit flow (PLAN.md 10.5 A)", () => {
  beforeEach(resetDb);

  it("recovers an account: start, complete, new password works, old one and old sessions do not", async () => {
    const known = await createKnownUser();
    const { client: oldDevice } = await loginAs(known);

    const { res } = await startRecovery(known);
    expect(res.status).toBe(200);
    const start = recoveryStartResponseSchema.parse(await readJson(res));
    expect(start).toMatchObject({ userId: known.user.id, wrappedAkRec: known.user.wrappedAkRec });

    // Only the token hash is stored, with a 10 minute lifetime.
    const [challenge] = await db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.kind, "recovery"));
    expect(challenge?.tokenHash).toBe(await sha256Hex(start.recoveryToken));
    expect(challenge?.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

    const change = passwordMaterial();
    const complete = await createClient().post(apiPaths.auth.recoveryComplete, {
      recoveryToken: start.recoveryToken,
      ...change,
    });
    expect(complete.status).toBe(200);
    const body = recoveryCompleteResponseSchema.parse(await readJson(complete));
    expect(body.keys).toMatchObject({
      userId: known.user.id,
      salt: change.newSalt,
      kdf: change.newKdf,
      wrappedAkPw: change.newWrappedAk,
    });
    expect(complete.headers.get("Set-Cookie")).toContain("pm_session=");

    const row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row?.securityStamp).toBe(known.user.securityStamp + 1);
    expect(row?.wrappedAkRec).toBe(known.user.wrappedAkRec); // the recovery kit stays valid

    // Old device is signed out, the old authKey is dead, the new one works.
    expect((await oldDevice.get(apiPaths.me.root)).status).toBe(401);
    const oldLogin = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: change.newAuthKey,
    });
    expect(loginOkResponseSchema.parse(await readJson(newLogin)).status).toBe("ok");

    // Notice email + audit entry.
    expect(
      emailsTo(known.user.email).some(
        (m) => m.subject.startsWith("Security notice") && m.text.includes("recovery kit"),
      ),
    ).toBe(true);
    const events = (
      await db.select().from(auditEvents).where(eq(auditEvents.userId, known.user.id))
    ).map((e) => e.event);
    expect(events).toContain("recovery_used");

    // The token and the email code are single use.
    const again = await createClient().post(apiPaths.auth.recoveryComplete, {
      recoveryToken: start.recoveryToken,
      ...passwordMaterial(),
    });
    expect(again.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(again)).error.code).toBe("challenge_invalid");
  });

  it("rejects a wrong or reused email code and locks a code after 5 wrong guesses", async () => {
    const known = await createKnownUser();
    const code = await requestCode(known.user.email, "recovery");
    const wrong = code === "000000" ? "111111" : "000000";

    const bad = await startRecovery(known, {}, { emailCode: wrong });
    expect(bad.res.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(bad.res)).error.code).toBe("email_code_invalid");

    const good = await startRecovery(known, {}, { emailCode: code });
    expect(good.res.status).toBe(200);
    const reused = await startRecovery(known, {}, { emailCode: code });
    expect(reused.res.status).toBe(400);

    // Once a code has used up its 5 attempts, even the right value is refused.
    const second = await requestCode(known.user.email, "recovery");
    await db.update(emailCodes).set({ attempts: 5 }).where(isNull(emailCodes.consumedAt));
    const locked = await startRecovery(known, {}, { emailCode: second });
    expect(locked.res.status).toBe(400);
  });

  it("rejects an expired email code and a code for another purpose", async () => {
    const known = await createKnownUser();
    const resetCode = await requestCode(known.user.email, "reset_account");
    const wrongPurpose = await startRecovery(known, {}, { emailCode: resetCode });
    expect(wrongPurpose.res.status).toBe(400);

    const code = await requestCode(known.user.email, "recovery");
    await db
      .update(emailCodes)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(emailCodes.purpose, "recovery"));
    const expired = await startRecovery(known, {}, { emailCode: code });
    expect(expired.res.status).toBe(400);
  });

  it("rejects a wrong recovery key without burning the email code", async () => {
    const known = await createKnownUser();
    const code = await requestCode(known.user.email, "recovery");
    const bad = await startRecovery(known, {}, { emailCode: code, recoveryAuthKey: fakeBlob(32) });
    expect(bad.res.status).toBe(401);
    expect(apiErrorSchema.parse(await readJson(bad.res)).error.code).toBe("invalid_credentials");
    // A typo in the phrase can be retried with the same code.
    const retry = await startRecovery(known, {}, { emailCode: code });
    expect(retry.res.status).toBe(200);
  });

  it("is limited to 5 starts per hour per email", async () => {
    const known = await createKnownUser();
    for (let i = 0; i < 5; i++) {
      const res = await createClient().post(apiPaths.auth.recoveryStart, {
        email: known.user.email,
        emailCode: "123456",
        recoveryAuthKey: known.recoveryAuthKey,
      });
      expect(res.status).toBe(400);
    }
    const res = await createClient().post(apiPaths.auth.recoveryStart, {
      email: known.user.email,
      emailCode: "123456",
      recoveryAuthKey: known.recoveryAuthKey,
    });
    expect(res.status).toBe(429);
  });

  it("does not reveal whether the account exists", async () => {
    const res = await createClient().post(apiPaths.auth.recoveryStart, {
      email: "ghost@example.test",
      emailCode: "123456",
      recoveryAuthKey: fakeBlob(32),
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("email_code_invalid");
  });

  it("requires a second factor when 2FA is enabled", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { secret, backupCodes } = await enableTotp(client);
    const code = await requestCode(known.user.email, "recovery");

    // Missing: 401 two_factor_required with the usable methods; the code is kept for the retry.
    const missing = await startRecovery(known, {}, { emailCode: code });
    expect(missing.res.status).toBe(401);
    const err = apiErrorSchema.parse(await readJson(missing.res));
    expect(err.error.code).toBe("two_factor_required");
    expect(err.error.details).toEqual({ methods: ["totp", "backup_code"] });

    const wrong = await startRecovery(
      known,
      { twoFactor: { method: "totp", code: "000000" } },
      { emailCode: code },
    );
    expect(wrong.res.status).toBe(401);
    expect(apiErrorSchema.parse(await readJson(wrong.res)).error.code).toBe("invalid_two_factor");

    // enableTotp consumed the current step, so use the next one.
    const ok = await startRecovery(
      known,
      { twoFactor: { method: "totp", code: totpCode(secret, Date.now() + 30_000) } },
      { emailCode: code },
    );
    expect(ok.res.status).toBe(200);
    recoveryStartResponseSchema.parse(await readJson(ok.res));

    // Backup code path.
    const code2 = await requestCode(known.user.email, "recovery");
    const viaBackup = await startRecovery(
      known,
      { twoFactor: { method: "backup_code", code: backupCodes?.[0] ?? "" } },
      { emailCode: code2 },
    );
    expect(viaBackup.res.status).toBe(200);
    // That backup code is now used.
    const code3 = await requestCode(known.user.email, "recovery");
    const reused = await startRecovery(
      known,
      { twoFactor: { method: "backup_code", code: backupCodes?.[0] ?? "" } },
      { emailCode: code3 },
    );
    expect(reused.res.status).toBe(401);
  });

  it("only the newest recovery token works, and a password change voids it", async () => {
    const known = await createKnownUser();
    const first = recoveryStartResponseSchema.parse(
      await readJson((await startRecovery(known)).res),
    );
    const second = recoveryStartResponseSchema.parse(
      await readJson((await startRecovery(known)).res),
    );
    const stale = await createClient().post(apiPaths.auth.recoveryComplete, {
      recoveryToken: first.recoveryToken,
      ...passwordMaterial(),
    });
    expect(stale.status).toBe(400);

    const { client } = await loginAs(known);
    const changed = await client.post(apiPaths.me.password, {
      currentAuthKey: known.authKey,
      ...passwordMaterial(),
    });
    expect(changed.status).toBe(200);
    const voided = await createClient().post(apiPaths.auth.recoveryComplete, {
      recoveryToken: second.recoveryToken,
      ...passwordMaterial(),
    });
    expect(voided.status).toBe(400);
  });

  it("rejects an expired recovery token", async () => {
    const known = await createKnownUser();
    const start = recoveryStartResponseSchema.parse(
      await readJson((await startRecovery(known)).res),
    );
    await db
      .update(authChallenges)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(authChallenges.kind, "recovery"));
    const res = await createClient().post(apiPaths.auth.recoveryComplete, {
      recoveryToken: start.recoveryToken,
      ...passwordMaterial(),
    });
    expect(res.status).toBe(400);
  });
});

describe("reset account (PLAN.md 10.5 D)", () => {
  beforeEach(resetDb);

  it("wipes the account, writes tombstones for other users and starts a fresh account", async () => {
    // A is the user who resets. B shares both ways with A.
    const a = await createKnownUser();
    const b = await createUser();
    const { client: aOldDevice } = await loginAs(a);

    const { vault: vaultA } = await createVaultWithOwner(a.user);
    const itemA = await createItem(vaultA, a.user);
    const now = Date.now();
    const [memberB] = await db
      .insert(vaultMembers)
      .values({
        id: crypto.randomUUID(),
        vaultId: vaultA.id,
        userId: b.id,
        role: "editor",
        keyVersion: 1,
        sealedKey: fakeBlob(80),
        status: "active",
        invitedBy: a.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [shareToB] = await db
      .insert(itemShares)
      .values({
        id: crypto.randomUUID(),
        itemId: itemA.id,
        userId: b.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: fakeBlob(80),
        status: "active",
        invitedBy: a.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const { vault: vaultB } = await createVaultWithOwner(b);
    const itemB = await createItem(vaultB, b);
    const [memberA] = await db
      .insert(vaultMembers)
      .values({
        id: crypto.randomUUID(),
        vaultId: vaultB.id,
        userId: a.user.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: fakeBlob(80),
        status: "active",
        invitedBy: b.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [shareToA] = await db
      .insert(itemShares)
      .values({
        id: crypto.randomUUID(),
        itemId: itemB.id,
        userId: a.user.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: fakeBlob(80),
        status: "active",
        invitedBy: b.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const code = await requestCode(a.user.email, "reset_account");
    const material = accountMaterial();
    const res = await createClient().post(apiPaths.auth.resetAccount, {
      email: a.user.email,
      emailCode: code,
      ...material,
    });
    expect(res.status).toBe(201);
    const body = resetAccountResponseSchema.parse(await readJson(res));
    expect(body.user).toMatchObject({ id: material.user.id, email: a.user.email, role: "user" });
    expect(body.user.id).not.toBe(a.user.id);
    expect(res.headers.get("Set-Cookie")).toContain("pm_session=");

    // Old user, vault, items, memberships and shares are gone; B's own data is intact.
    expect(await db.select().from(users).where(eq(users.id, a.user.id))).toHaveLength(0);
    expect(await db.select().from(vaults).where(eq(vaults.id, vaultA.id))).toHaveLength(0);
    expect(await db.select().from(items).where(eq(items.id, itemA.id))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(vaultMembers)
        .where(eq(vaultMembers.id, memberB?.id ?? "")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(itemShares)
        .where(eq(itemShares.id, shareToB?.id ?? "")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(vaultMembers)
        .where(eq(vaultMembers.id, memberA?.id ?? "")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(itemShares)
        .where(eq(itemShares.id, shareToA?.id ?? "")),
    ).toHaveLength(0);
    expect(await db.select().from(vaults).where(eq(vaults.id, vaultB.id))).toHaveLength(1);
    expect(await db.select().from(items).where(eq(items.id, itemB.id))).toHaveLength(1);

    // The new account has its own vault and owner membership.
    expect(await db.select().from(vaults).where(eq(vaults.ownerId, material.user.id))).toHaveLength(
      1,
    );
    expect(
      await db
        .select()
        .from(vaultMembers)
        .where(and(eq(vaultMembers.userId, material.user.id), eq(vaultMembers.role, "owner"))),
    ).toHaveLength(1);
    // Only the new session exists; the old device is signed out.
    const left = await db.select().from(sessions).where(eq(sessions.userId, material.user.id));
    expect(left).toHaveLength(1);
    expect((await aOldDevice.get(apiPaths.me.root)).status).toBe(401);

    // Tombstones (PLAN.md 13, shared rule with the vault routes).
    const tombstones = await db.select().from(deletions);
    const pick = (entity: string, entityId: string) =>
      tombstones.filter((t) => t.entity === entity && t.entityId === entityId);
    // vault A removed -> B learns about it through user_id
    expect(pick("vault", vaultA.id).map((t) => t.userId)).toEqual([b.id]);
    // share of itemA to B -> B
    expect(pick("item_share", shareToB?.id ?? "").map((t) => [t.userId, t.vaultId])).toEqual([
      [b.id, vaultA.id],
    ]);
    // A's membership in B's vault -> members of vault B (user_id NULL + vault_id)
    expect(pick("vault_member", memberA?.id ?? "").map((t) => [t.userId, t.vaultId])).toEqual([
      [null, vaultB.id],
    ]);
    // A's share on B's item -> members of vault B
    expect(pick("item_share", shareToA?.id ?? "").map((t) => [t.userId, t.vaultId])).toEqual([
      [null, vaultB.id],
    ]);
    expect(tombstones).toHaveLength(4);
    for (const t of tombstones) expect(t.deletedAt).toBeGreaterThanOrEqual(now);

    // The new keys log in; the old authKey does not.
    const newLogin = await createClient().post(apiPaths.auth.login, {
      email: a.user.email,
      authKey: material.user.authKey,
    });
    expect(newLogin.status).toBe(200);
    const oldLogin = await createClient().post(apiPaths.auth.login, {
      email: a.user.email,
      authKey: a.authKey,
    });
    expect(oldLogin.status).toBe(401);

    expect(
      emailsTo(a.user.email).some(
        (m) => m.subject.startsWith("Security notice") && m.text.includes("reset"),
      ),
    ).toBe(true);
    const events = (
      await db.select().from(auditEvents).where(eq(auditEvents.userId, material.user.id))
    ).map((e) => e.event);
    expect(events).toContain("account_reset");
  });

  it("clears 2FA and keeps the role", async () => {
    const a = await createKnownUser({ role: "admin" });
    await createKnownUser({ role: "admin" }); // another admin, irrelevant to the rule
    const { client } = await loginAs(a);
    await enableTotp(client);
    const code = await requestCode(a.user.email, "reset_account");
    const material = accountMaterial();
    const res = await createClient().post(apiPaths.auth.resetAccount, {
      email: a.user.email,
      emailCode: code,
      ...material,
    });
    expect(res.status).toBe(201);
    expect(resetAccountResponseSchema.parse(await readJson(res)).user).toMatchObject({
      role: "admin",
      twoFactor: { totp: false, webauthn: 0 },
    });
  });

  it("needs a valid reset_account code and refuses other codes", async () => {
    const a = await createKnownUser();
    const recoveryCode = await requestCode(a.user.email, "recovery");
    const material = accountMaterial();
    const res = await createClient().post(apiPaths.auth.resetAccount, {
      email: a.user.email,
      emailCode: recoveryCode,
      ...material,
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("email_code_invalid");
    expect(await db.select().from(users).where(eq(users.id, a.user.id))).toHaveLength(1);

    const ghost = await createClient().post(apiPaths.auth.resetAccount, {
      email: "ghost@example.test",
      emailCode: "123456",
      ...accountMaterial(),
    });
    expect(ghost.status).toBe(400);
  });

  it("refuses a disabled account", async () => {
    const a = await createKnownUser({ status: "disabled" });
    // email/start does not mail disabled accounts, so plant a code the way a once-active user had one.
    await db.insert(emailCodes).values({
      id: crypto.randomUUID(),
      email: a.user.email,
      purpose: "reset_account",
      codeHash: "x",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const res = await createClient().post(apiPaths.auth.resetAccount, {
      email: a.user.email,
      emailCode: "123456",
      ...accountMaterial(),
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(users).where(eq(users.id, a.user.id))).toHaveLength(1);
  });
});
