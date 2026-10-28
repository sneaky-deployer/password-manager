import {
  acceptInviteResponseSchema,
  apiErrorSchema,
  apiPaths,
  inspectInviteResponseSchema,
  keyBundleSchema,
  meResponseSchema,
} from "@pm/shared";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditEvents, invites, sessions, users, vaultMembers, vaults } from "../src/db/schema.ts";
import { base64urlDecode, sha256Hex, verifyHmac } from "../src/lib/crypto.ts";
import {
  accountMaterial,
  config,
  createKnownUser,
  latestInviteToken,
} from "./account-test-utils.ts";
import { createClient, createUser, db, readJson, resetDb, signedInClient } from "./helpers.ts";

const NEW_EMAIL = "newbie@example.test";

/** Admin invites NEW_EMAIL through the API and returns the emailed token. */
async function inviteViaAdmin(email = NEW_EMAIL) {
  const { client, user } = await signedInClient({ role: "admin" });
  const res = await client.post(apiPaths.admin.invites, { email });
  expect(res.status).toBe(201);
  return { admin: user, token: latestInviteToken(email) };
}

describe("invites: inspect and accept (PLAN.md 10.1)", () => {
  beforeEach(resetDb);

  it("runs invite -> inspect -> accept -> me/keys -> login", async () => {
    const { admin, token } = await inviteViaAdmin();
    const anon = createClient();

    const inspect = await anon.post(apiPaths.invites.inspect, { token });
    expect(inspect.status).toBe(200);
    const inspected = inspectInviteResponseSchema.parse(await readJson(inspect));
    expect(inspected).toMatchObject({
      email: NEW_EMAIL,
      invitedBy: admin.email,
      kind: "new_account",
    });

    const material = accountMaterial();
    const accept = await anon.post(apiPaths.auth.acceptInvite, { token, ...material });
    expect(accept.status).toBe(201);
    const accepted = acceptInviteResponseSchema.parse(await readJson(accept));
    expect(accepted.user).toMatchObject({
      id: material.user.id,
      email: NEW_EMAIL,
      role: "user",
      twoFactor: { totp: false, webauthn: 0 },
    });
    expect(accept.headers.get("Set-Cookie")).toContain("pm_session=");

    // The session works and the key bundle matches what was uploaded.
    const me = meResponseSchema.parse(await readJson(await anon.get(apiPaths.me.root)));
    expect(me.user.id).toBe(material.user.id);
    const keys = keyBundleSchema.parse(await readJson(await anon.get(apiPaths.me.keys)));
    expect(keys).toEqual({
      userId: material.user.id,
      kdf: material.user.kdf,
      salt: material.user.salt,
      wrappedAkPw: material.user.wrappedAkPw,
      publicKey: material.user.publicKey,
      encryptedPrivateKey: material.user.encryptedPrivateKey,
      keyGeneration: 1,
    });

    // Rows: user (verified, stamp 1), vault + owner membership, invite accepted, audit.
    const user = await db.select().from(users).where(eq(users.id, material.user.id)).get();
    expect(user).toMatchObject({
      role: "user",
      status: "active",
      invitedBy: admin.id,
      securityStamp: 1,
      keyGeneration: 1,
    });
    expect(user?.emailVerifiedAt).toBeGreaterThan(0);
    // Verifiers are HMACs of the keys, not the keys themselves.
    expect(user?.authVerifier).not.toBe(material.user.authKey);
    expect(
      await verifyHmac(
        config().authPepper,
        base64urlDecode(material.user.authKey),
        user?.authVerifier ?? "",
      ),
    ).toBe(true);
    expect(
      await verifyHmac(
        config().authPepper,
        base64urlDecode(material.user.recoveryAuthKey),
        user?.recoveryVerifier ?? "",
      ),
    ).toBe(true);
    const vault = await db.select().from(vaults).where(eq(vaults.id, material.vault.id)).get();
    expect(vault).toMatchObject({ ownerId: material.user.id, keyVersion: 1 });
    const member = await db
      .select()
      .from(vaultMembers)
      .where(
        and(eq(vaultMembers.vaultId, material.vault.id), eq(vaultMembers.userId, material.user.id)),
      )
      .get();
    expect(member).toMatchObject({
      role: "owner",
      status: "active",
      keyVersion: 1,
      sealedKey: material.vault.sealedKey,
    });
    const invite = await db.select().from(invites).where(eq(invites.email, NEW_EMAIL)).get();
    expect(invite?.acceptedAt).toBeGreaterThan(0);
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.userId, material.user.id));
    expect(events.map((e) => e.event)).toEqual(["account_created"]);

    // A fresh login with the same authKey works.
    const login = await createClient().post(apiPaths.auth.login, {
      email: NEW_EMAIL,
      authKey: material.user.authKey,
    });
    expect(login.status).toBe(200);
  });

  it("creates an admin account from the setup invite", async () => {
    const anon = createClient();
    await anon.post(apiPaths.setup.start);
    const token = latestInviteToken("owner@example.test");
    const material = accountMaterial();
    const res = await anon.post(apiPaths.auth.acceptInvite, { token, ...material });
    expect(res.status).toBe(201);
    expect(acceptInviteResponseSchema.parse(await readJson(res)).user.role).toBe("admin");
    const status = await anon.get(apiPaths.setup.status);
    expect(await readJson(status)).toEqual({ needsSetup: false });
  });

  it("answers 410 invite_invalid for unknown, expired, revoked and reused tokens", async () => {
    const anon = createClient();
    const expectInvalid = async (token: string) => {
      const inspect = await anon.post(apiPaths.invites.inspect, { token });
      expect(inspect.status).toBe(410);
      expect(apiErrorSchema.parse(await readJson(inspect)).error.code).toBe("invite_invalid");
      const accept = await createClient().post(apiPaths.auth.acceptInvite, {
        token,
        ...accountMaterial(),
      });
      expect(accept.status).toBe(410);
      expect(apiErrorSchema.parse(await readJson(accept)).error.code).toBe("invite_invalid");
    };

    // Unknown token.
    await expectInvalid("A".repeat(43));

    // Expired.
    const expired = await inviteViaAdmin("expired@example.test");
    await db
      .update(invites)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(invites.email, "expired@example.test"));
    await expectInvalid(expired.token);

    // Revoked.
    const revoked = await inviteViaAdmin("revoked@example.test");
    const row = await db
      .select()
      .from(invites)
      .where(eq(invites.email, "revoked@example.test"))
      .get();
    await db
      .update(invites)
      .set({ revokedAt: Date.now() })
      .where(eq(invites.id, row?.id ?? ""));
    await expectInvalid(revoked.token);

    // Reused after a successful accept.
    const used = await inviteViaAdmin("used@example.test");
    const first = await createClient().post(apiPaths.auth.acceptInvite, {
      token: used.token,
      ...accountMaterial(),
    });
    expect(first.status).toBe(201);
    await expectInvalid(used.token);
    expect(await db.select().from(users).where(eq(users.email, "used@example.test"))).toHaveLength(
      1,
    );
  });

  it("rejects an invite whose email already has an account (email_taken)", async () => {
    const { token } = await inviteViaAdmin();
    // The account appears after the invite was sent (e.g. created through another path).
    await createUser({ email: NEW_EMAIL });
    const res = await createClient().post(apiPaths.auth.acceptInvite, {
      token,
      ...accountMaterial(),
    });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("email_taken");
    expect(await db.select().from(sessions)).toHaveLength(1); // only the admin's helper session
  });

  it("validates the account material", async () => {
    const { token } = await inviteViaAdmin();
    const material = accountMaterial();
    const res = await createClient().post(apiPaths.auth.acceptInvite, {
      token,
      ...material,
      user: { ...material.user, kdf: { alg: "argon2id13", mem: 1024, ops: 1 } },
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("validation_error");
  });

  it("rate limits invite attempts per IP (20 per 15 minutes)", async () => {
    const anon = createClient();
    for (let i = 0; i < 20; i++) {
      const res = await anon.post(apiPaths.invites.inspect, { token: "B".repeat(43) });
      expect(res.status).toBe(410);
    }
    const res = await anon.post(apiPaths.invites.inspect, { token: "B".repeat(43) });
    expect(res.status).toBe(429);
    // accept-invite shares the budget.
    const accept = await anon.post(apiPaths.auth.acceptInvite, {
      token: "B".repeat(43),
      ...accountMaterial(),
    });
    expect(accept.status).toBe(429);
  });

  it("replaces the old account when an account_reset invite is accepted", async () => {
    // An admin reset normally deletes the account right away; simulate the "still present" case.
    const old = await createKnownUser({ email: NEW_EMAIL });
    const { user: admin } = await signedInClient({ role: "admin" });
    const row = await db
      .insert(invites)
      .values({
        id: crypto.randomUUID(),
        email: NEW_EMAIL,
        role: "user",
        tokenHash: await sha256Hex("R".repeat(43)),
        invitedBy: admin.id,
        kind: "account_reset",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      })
      .returning();
    expect(row).toHaveLength(1);

    const material = accountMaterial();
    const res = await createClient().post(apiPaths.auth.acceptInvite, {
      token: "R".repeat(43),
      ...material,
    });
    expect(res.status).toBe(201);
    const found = await db.select().from(users).where(eq(users.email, NEW_EMAIL));
    expect(found.map((u) => u.id)).toEqual([material.user.id]);
    expect(found[0]?.id).not.toBe(old.user.id);
  });
});
