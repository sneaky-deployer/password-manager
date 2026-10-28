import {
  acceptInviteResponseSchema,
  apiErrorSchema,
  apiPaths,
  createInviteResponseSchema,
  inspectInviteResponseSchema,
  listInvitesResponseSchema,
  listUsersResponseSchema,
  okResponseSchema,
  resetUserResponseSchema,
  updateUserResponseSchema,
} from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  deletions,
  invites,
  sessions,
  users,
  vaultMembers,
  vaults,
} from "../src/db/schema.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { getDevOutbox } from "../src/lib/email.ts";
import {
  accountMaterial,
  createKnownUser,
  emailsTo,
  enableTotp,
  latestInviteToken,
  loginAs,
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
  signedInClient,
} from "./helpers.ts";

const INVITEE = "invitee@example.test";

async function inviteId(email: string) {
  const row = await db.select().from(invites).where(eq(invites.email, email)).get();
  if (!row) throw new Error("no invite");
  return row.id;
}

describe("admin access control", () => {
  beforeEach(resetDb);

  it("answers 401 without a session and 403 for non-admins on every endpoint", async () => {
    const id = crypto.randomUUID();
    const calls: Array<[string, string, unknown?]> = [
      ["GET", apiPaths.admin.invites],
      ["POST", apiPaths.admin.invites, { email: INVITEE }],
      ["POST", apiPaths.admin.inviteResend(id), {}],
      ["POST", apiPaths.admin.inviteRevoke(id), {}],
      ["GET", apiPaths.admin.users],
      ["PATCH", apiPaths.admin.user(id), { role: "admin" }],
      ["POST", apiPaths.admin.userReset(id), {}],
      ["DELETE", apiPaths.admin.user(id)],
    ];
    const anon = createClient();
    const { client: normal } = await signedInClient({ role: "user" });
    for (const [method, path, json] of calls) {
      const unauthenticated = await anon.request(method, path, json === undefined ? {} : { json });
      expect(unauthenticated.status, `${method} ${path}`).toBe(401);
      const forbidden = await normal.request(method, path, json === undefined ? {} : { json });
      expect(forbidden.status, `${method} ${path}`).toBe(403);
      expect(apiErrorSchema.parse(await readJson(forbidden)).error.code).toBe("forbidden");
    }
    expect(getDevOutbox()).toHaveLength(0);
  });
});

describe("admin invites (PLAN.md 10.1)", () => {
  beforeEach(resetDb);

  it("creates an invite, emails the fragment link and stores only the hash", async () => {
    const { client, user: admin } = await signedInClient({ role: "admin" });
    const res = await client.post(apiPaths.admin.invites, { email: ` ${INVITEE.toUpperCase()} ` });
    expect(res.status).toBe(201);
    const { invite } = createInviteResponseSchema.parse(await readJson(res));
    expect(invite).toMatchObject({
      email: INVITEE,
      role: "user",
      kind: "new_account",
      status: "pending",
      invitedBy: admin.id,
      acceptedAt: null,
      revokedAt: null,
    });
    const ttl = invite.expiresAt - invite.createdAt;
    expect(ttl).toBe(72 * 60 * 60 * 1000);

    const mails = emailsTo(INVITEE);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toContain(admin.email);
    const token = latestInviteToken(INVITEE);
    expect(mails[0]?.text).toContain(`https://pm.test/invite#t=${token}`);
    const row = await db.select().from(invites).where(eq(invites.email, INVITEE)).get();
    expect(row?.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain(token);
  });

  it("rejects an existing user or a live invite with 409 email_taken", async () => {
    const { client } = await signedInClient({ role: "admin" });
    const existing = await createUser();
    const taken = await client.post(apiPaths.admin.invites, { email: existing.email });
    expect(taken.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(taken)).error.code).toBe("email_taken");

    expect((await client.post(apiPaths.admin.invites, { email: INVITEE })).status).toBe(201);
    const duplicate = await client.post(apiPaths.admin.invites, { email: INVITEE });
    expect(duplicate.status).toBe(409);
    expect(emailsTo(INVITEE)).toHaveLength(1);

    // Allowed again once the first one is revoked or has expired.
    await client.post(apiPaths.admin.inviteRevoke(await inviteId(INVITEE)));
    expect((await client.post(apiPaths.admin.invites, { email: INVITEE })).status).toBe(201);
    await db.update(invites).set({ expiresAt: Date.now() - 1 });
    expect((await client.post(apiPaths.admin.invites, { email: INVITEE })).status).toBe(201);
  });

  it("validates the email", async () => {
    const { client } = await signedInClient({ role: "admin" });
    expect((await client.post(apiPaths.admin.invites, { email: "not-an-email" })).status).toBe(400);
    expect(
      (await client.post(apiPaths.admin.invites, { email: INVITEE, role: "admin" })).status,
    ).toBe(400);
  });

  it("lists invites with derived statuses", async () => {
    const { client } = await signedInClient({ role: "admin" });
    for (const email of ["pending@e.test", "revoked@e.test", "expired@e.test", "accepted@e.test"]) {
      await client.post(apiPaths.admin.invites, { email });
    }
    const acceptedToken = latestInviteToken("accepted@e.test");
    expect(
      (
        await createClient().post(apiPaths.auth.acceptInvite, {
          token: acceptedToken,
          ...accountMaterial(),
        })
      ).status,
    ).toBe(201);
    await client.post(apiPaths.admin.inviteRevoke(await inviteId("revoked@e.test")));
    await db
      .update(invites)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(invites.email, "expired@e.test"));

    const list = listInvitesResponseSchema.parse(
      await readJson(await client.get(apiPaths.admin.invites)),
    );
    const byEmail = Object.fromEntries(list.invites.map((i) => [i.email, i.status]));
    expect(byEmail).toEqual({
      "pending@e.test": "pending",
      "revoked@e.test": "revoked",
      "expired@e.test": "expired",
      "accepted@e.test": "accepted",
    });
    // Token hashes are never part of the list.
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|token_hash/);
  });

  it("resend issues a new token and invalidates the old one", async () => {
    const { client } = await signedInClient({ role: "admin" });
    await client.post(apiPaths.admin.invites, { email: INVITEE });
    const oldToken = latestInviteToken(INVITEE);
    const id = await inviteId(INVITEE);
    // An expired invite can be revived by resending.
    await db
      .update(invites)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(invites.id, id));

    const res = await client.post(apiPaths.admin.inviteResend(id));
    expect(res.status).toBe(200);
    const { invite } = createInviteResponseSchema.parse(await readJson(res));
    expect(invite).toMatchObject({ id, status: "pending" });
    expect(invite.expiresAt).toBeGreaterThan(Date.now());

    const newToken = latestInviteToken(INVITEE);
    expect(newToken).not.toBe(oldToken);
    expect(emailsTo(INVITEE)).toHaveLength(2);

    const anon = createClient();
    expect((await anon.post(apiPaths.invites.inspect, { token: oldToken })).status).toBe(410);
    const inspect = await anon.post(apiPaths.invites.inspect, { token: newToken });
    expect(inspectInviteResponseSchema.parse(await readJson(inspect)).email).toBe(INVITEE);
  });

  it("resend and revoke refuse accepted invites; revoke is idempotent; unknown ids are 404", async () => {
    const { client } = await signedInClient({ role: "admin" });
    await client.post(apiPaths.admin.invites, { email: INVITEE });
    const id = await inviteId(INVITEE);

    const revoked = await client.post(apiPaths.admin.inviteRevoke(id));
    expect(revoked.status).toBe(200);
    expect(createInviteResponseSchema.parse(await readJson(revoked)).invite.status).toBe("revoked");
    const again = await client.post(apiPaths.admin.inviteRevoke(id));
    expect(again.status).toBe(200);
    expect((await client.post(apiPaths.admin.inviteResend(id))).status).toBe(409);
    expect(
      (await createClient().post(apiPaths.invites.inspect, { token: latestInviteToken(INVITEE) }))
        .status,
    ).toBe(410);

    await client.post(apiPaths.admin.invites, { email: "second@e.test" });
    const secondId = await inviteId("second@e.test");
    await createClient().post(apiPaths.auth.acceptInvite, {
      token: latestInviteToken("second@e.test"),
      ...accountMaterial(),
    });
    expect((await client.post(apiPaths.admin.inviteResend(secondId))).status).toBe(409);
    expect((await client.post(apiPaths.admin.inviteRevoke(secondId))).status).toBe(409);

    expect((await client.post(apiPaths.admin.inviteResend(crypto.randomUUID()))).status).toBe(404);
    expect((await client.post(apiPaths.admin.inviteRevoke(crypto.randomUUID()))).status).toBe(404);
    expect((await client.post(`${apiPaths.admin.invites}/nope/resend`)).status).toBe(400);
  });
});

describe("admin users (PLAN.md 10.1a)", () => {
  beforeEach(resetDb);

  it("lists users with metadata only", async () => {
    const { client, user: admin } = await signedInClient({ role: "admin" });
    const known = await createKnownUser();
    const { client: userClient } = await loginAs(known);
    await enableTotp(userClient);
    await createVaultWithOwner(known.user);

    const res = await client.get(apiPaths.admin.users);
    expect(res.status).toBe(200);
    const body = listUsersResponseSchema.parse(await readJson(res));
    expect(body.users.map((u) => u.email).sort()).toEqual([admin.email, known.user.email].sort());
    const row = body.users.find((u) => u.id === known.user.id);
    expect(row).toMatchObject({ role: "user", status: "active", twoFactorEnabled: true });
    expect(row?.lastLoginAt).toBeGreaterThan(0);
    expect(body.users.find((u) => u.id === admin.id)).toMatchObject({
      twoFactorEnabled: false,
      lastLoginAt: null,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(known.user.authVerifier);
    expect(text).not.toContain(known.user.wrappedAkPw);
    expect(text).not.toMatch(/totp_secret|totpSecret|publicKey/);
  });

  it("promotes and demotes users, and protects the last active admin", async () => {
    const { client, user: admin } = await signedInClient({ role: "admin" });
    const other = await createUser();

    const promote = await client.patch(apiPaths.admin.user(other.id), { role: "admin" });
    expect(promote.status).toBe(200);
    expect(updateUserResponseSchema.parse(await readJson(promote)).user).toMatchObject({
      id: other.id,
      role: "admin",
    });
    expect(
      (await db.select().from(auditEvents).where(eq(auditEvents.userId, other.id))).map(
        (e) => e.event,
      ),
    ).toContain("role_changed");

    // Two admins: demoting one is fine (including oneself).
    const demoteSelf = await client.patch(apiPaths.admin.user(admin.id), { role: "user" });
    expect(demoteSelf.status).toBe(200);
    // Now `other` is the only admin and `admin` (a plain user) lost access to admin routes.
    expect((await client.get(apiPaths.admin.users)).status).toBe(403);

    const { client: otherClient } = { client: createClient() };
    const session = await createTestSession(other);
    otherClient.jar.set(session.cookieName, session.token);
    const demoteLast = await otherClient.patch(apiPaths.admin.user(other.id), { role: "user" });
    expect(demoteLast.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(demoteLast)).error.code).toBe("last_admin");
    const disableLast = await otherClient.patch(apiPaths.admin.user(other.id), {
      status: "disabled",
    });
    expect(disableLast.status).toBe(409);
    expect(apiErrorSchema.parse(await readJson(disableLast)).error.code).toBe("last_admin");
    expect((await db.select().from(users).where(eq(users.id, other.id)).get())?.role).toBe("admin");
    expect((await db.select().from(users).where(eq(users.id, other.id)).get())?.status).toBe(
      "active",
    );
  });

  it("disabling revokes sessions, blocks login and can be undone", async () => {
    const { client } = await signedInClient({ role: "admin" });
    const known = await createKnownUser();
    const { client: userClient } = await loginAs(known);
    expect((await userClient.get(apiPaths.me.root)).status).toBe(200);

    const disable = await client.patch(apiPaths.admin.user(known.user.id), { status: "disabled" });
    expect(disable.status).toBe(200);
    expect(updateUserResponseSchema.parse(await readJson(disable)).user.status).toBe("disabled");
    expect((await userClient.get(apiPaths.me.root)).status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, known.user.id))).toHaveLength(
      0,
    );
    const login = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(login.status).toBe(403);
    expect(apiErrorSchema.parse(await readJson(login)).error.code).toBe("account_disabled");

    const enable = await client.patch(apiPaths.admin.user(known.user.id), { status: "active" });
    expect(updateUserResponseSchema.parse(await readJson(enable)).user.status).toBe("active");
    const again = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(again.status).toBe(200);
  });

  it("validates the patch and the id", async () => {
    const { client } = await signedInClient({ role: "admin" });
    const other = await createUser();
    expect((await client.patch(apiPaths.admin.user(other.id), {})).status).toBe(400);
    expect((await client.patch(apiPaths.admin.user(other.id), { role: "owner" })).status).toBe(400);
    expect(
      (await client.patch(apiPaths.admin.user(crypto.randomUUID()), { role: "admin" })).status,
    ).toBe(404);
  });

  it("resets a user: data wiped with tombstones, reset invite emailed, fresh account on accept", async () => {
    const { client, user: admin } = await signedInClient({ role: "admin" });
    const known = await createKnownUser();
    const member = await createUser();
    const { client: userClient } = await loginAs(known);
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

    const res = await client.post(apiPaths.admin.userReset(known.user.id));
    expect(res.status).toBe(201);
    const { invite } = resetUserResponseSchema.parse(await readJson(res));
    expect(invite).toMatchObject({
      email: known.user.email,
      kind: "account_reset",
      role: "user",
      invitedBy: admin.id,
      status: "pending",
    });

    // Data and sessions are gone, members learn about it.
    expect(await db.select().from(users).where(eq(users.id, known.user.id))).toHaveLength(0);
    expect(await db.select().from(vaults).where(eq(vaults.id, vault.id))).toHaveLength(0);
    expect((await userClient.get(apiPaths.me.root)).status).toBe(401);
    const tombstones = await db.select().from(deletions);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ entity: "vault", entityId: vault.id, userId: member.id });
    // The old password no longer works.
    const stale = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(stale.status).toBe(401);

    // The user gets a reset-style invite and sets up from scratch.
    const mail = emailsTo(known.user.email).at(-1);
    expect(mail?.text).toContain("reset your Password Manager account");
    const token = latestInviteToken(known.user.email);
    const anon = createClient();
    const inspect = inspectInviteResponseSchema.parse(
      await readJson(await anon.post(apiPaths.invites.inspect, { token })),
    );
    expect(inspect).toMatchObject({
      email: known.user.email,
      kind: "account_reset",
      invitedBy: admin.email,
    });
    const material = accountMaterial();
    const accept = await anon.post(apiPaths.auth.acceptInvite, { token, ...material });
    expect(accept.status).toBe(201);
    expect(acceptInviteResponseSchema.parse(await readJson(accept)).user).toMatchObject({
      id: material.user.id,
      role: "user",
    });
    const login = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: material.user.authKey,
    });
    expect(login.status).toBe(200);
    expect(
      (await createClient().post(apiPaths.auth.acceptInvite, { token, ...accountMaterial() }))
        .status,
    ).toBe(410);
  });

  it("cannot reset or delete oneself, and reports unknown users", async () => {
    const { client, user: admin } = await signedInClient({ role: "admin" });
    expect((await client.post(apiPaths.admin.userReset(admin.id))).status).toBe(409);
    expect((await client.delete(apiPaths.admin.user(admin.id))).status).toBe(409);
    expect((await client.post(apiPaths.admin.userReset(crypto.randomUUID()))).status).toBe(404);
    expect((await client.delete(apiPaths.admin.user(crypto.randomUUID()))).status).toBe(404);
    expect(await db.select().from(users).where(eq(users.id, admin.id))).toHaveLength(1);
  });

  it("deletes a user with their owned data and tombstones", async () => {
    const { client } = await signedInClient({ role: "admin" });
    const victim = await createUser();
    const member = await createUser();
    const { vault } = await createVaultWithOwner(victim);
    const now = Date.now();
    await db.insert(vaultMembers).values({
      id: crypto.randomUUID(),
      vaultId: vault.id,
      userId: member.id,
      role: "editor",
      keyVersion: 1,
      sealedKey: fakeBlob(80),
      status: "active",
      invitedBy: victim.id,
      createdAt: now,
      updatedAt: now,
    });
    await createTestSession(victim);

    const res = await client.delete(apiPaths.admin.user(victim.id));
    expect(res.status).toBe(200);
    expect(okResponseSchema.parse(await readJson(res))).toEqual({ ok: true });
    expect(await db.select().from(users).where(eq(users.id, victim.id))).toHaveLength(0);
    expect(await db.select().from(vaults).where(eq(vaults.id, vault.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, victim.id))).toHaveLength(0);
    const tombstones = await db.select().from(deletions);
    expect(tombstones.map((t) => [t.entity, t.userId])).toEqual([["vault", member.id]]);
    expect(getDevOutbox()).toHaveLength(0);
  });
});
