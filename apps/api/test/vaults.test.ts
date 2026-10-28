import {
  createVaultResponseSchema,
  deleteVaultResponseSchema,
  inviteMemberResponseSchema,
  leaveVaultResponseSchema,
  removeMemberResponseSchema,
  updateMemberResponseSchema,
  updateVaultResponseSchema,
} from "@pm/shared";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deletions, items, vaultMembers, vaults } from "../src/db/schema.ts";
import {
  createItem,
  createUser,
  createVaultWithOwner,
  db,
  resetDb,
  signedInClient,
} from "./helpers.ts";
import { addMember, body, meta, parseWith, sealed, uuid, vaultWithRoles } from "./vault-helpers.ts";

type ErrorBody = { error: { code: string; details?: Record<string, unknown> } };

describe("POST /api/vaults", () => {
  beforeEach(resetDb);

  it("creates a vault with the owner membership in one go", async () => {
    const { client, user } = await signedInClient();
    const id = uuid();
    const res = await client.post("/api/vaults", {
      id,
      keyVersion: 1,
      encryptedMeta: meta(),
      sealedKey: sealed(),
    });
    expect(res.status).toBe(201);
    const parsed = parseWith(createVaultResponseSchema, await body(res));
    expect(parsed.vault).toMatchObject({ id, ownerId: user.id, keyVersion: 1, myRole: "owner" });
    expect(parsed.vault.rotationPending).toBe(false);
    expect(parsed.member).toMatchObject({ userId: user.id, role: "owner", status: "active" });
    expect(parsed.member.sealedKey).toBeDefined();
    expect(parsed.member.email).toBe(user.email);
  });

  it("rejects a duplicate id with 409 and bad bodies with 400", async () => {
    const { client } = await signedInClient();
    const other = await signedInClient();
    const payload = { id: uuid(), keyVersion: 1, encryptedMeta: meta(), sealedKey: sealed() };
    expect((await client.post("/api/vaults", payload)).status).toBe(201);
    const dup = await other.client.post("/api/vaults", payload);
    expect(dup.status).toBe(409);
    expect((await body<ErrorBody>(dup)).error.code).toBe("conflict");
    expect((await client.post("/api/vaults", { ...payload, keyVersion: 2 })).status).toBe(400);
  });

  it("requires a session", async () => {
    const { client } = await signedInClient();
    client.jar.clear();
    const res = await client.post("/api/vaults", { id: uuid() });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/vaults/:id", () => {
  beforeEach(resetDb);

  it("lets owner and manager rename, not editor or viewer, not outsiders", async () => {
    const t = await vaultWithRoles();
    const payload = () => ({ keyVersion: 1, encryptedMeta: meta() });
    const path = `/api/vaults/${t.vault.id}`;

    const ok = await t.owner.client.patch(path, payload());
    expect(ok.status).toBe(200);
    const parsed = parseWith(updateVaultResponseSchema, await body(ok));
    expect(parsed.vault.myRole).toBe("owner");
    expect((await t.manager.client.patch(path, payload())).status).toBe(200);
    expect((await t.editor.client.patch(path, payload())).status).toBe(403);
    expect((await t.viewer.client.patch(path, payload())).status).toBe(403);
    expect((await t.outsider.client.patch(path, payload())).status).toBe(404);
  });

  it("bumps updated_at and rejects a stale key version", async () => {
    const t = await vaultWithRoles();
    const path = `/api/vaults/${t.vault.id}`;
    const newMeta = meta();
    const res = await t.owner.client.patch(path, { keyVersion: 1, encryptedMeta: newMeta });
    const { vault } = parseWith(updateVaultResponseSchema, await body(res));
    expect(vault.encryptedMeta).toBe(newMeta);
    expect(vault.updatedAt).toBeGreaterThanOrEqual(t.vault.updatedAt);

    const stale = await t.owner.client.patch(path, { keyVersion: 2, encryptedMeta: meta() });
    expect(stale.status).toBe(409);
    expect((await body<ErrorBody>(stale)).error.code).toBe("key_version_mismatch");
  });

  it("is blocked while a rotation is pending", async () => {
    const t = await vaultWithRoles();
    await db.update(vaults).set({ rotationPending: true }).where(eq(vaults.id, t.vault.id));
    const res = await t.owner.client.patch(`/api/vaults/${t.vault.id}`, {
      keyVersion: 1,
      encryptedMeta: meta(),
    });
    expect(res.status).toBe(409);
    expect((await body<ErrorBody>(res)).error.code).toBe("rotation_pending");
  });
});

describe("DELETE /api/vaults/:id", () => {
  beforeEach(resetDb);

  it("is owner only", async () => {
    const t = await vaultWithRoles();
    const path = `/api/vaults/${t.vault.id}`;
    expect((await t.manager.client.delete(path)).status).toBe(403);
    expect((await t.editor.client.delete(path)).status).toBe(403);
    expect((await t.outsider.client.delete(path)).status).toBe(404);
    const res = await t.owner.client.delete(path);
    expect(res.status).toBe(200);
    parseWith(deleteVaultResponseSchema, await body(res));
  });

  it("deletes items and memberships and leaves one vault tombstone per member", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const res = await t.owner.client.delete(`/api/vaults/${t.vault.id}`);
    expect(res.status).toBe(200);

    expect(await db.select().from(vaults)).toHaveLength(0);
    expect(await db.select().from(items).where(eq(items.id, item.id))).toHaveLength(0);
    expect(await db.select().from(vaultMembers)).toHaveLength(0);

    const tombstones = await db.select().from(deletions).where(eq(deletions.entity, "vault"));
    expect(tombstones.map((row) => row.userId).sort()).toEqual(
      [t.owner, t.manager, t.editor, t.viewer].map((a) => a.user.id).sort(),
    );
    for (const row of tombstones) expect(row.entityId).toBe(t.vault.id);
  });
});

describe("members", () => {
  beforeEach(resetDb);

  async function invite(
    actor: { client: { post: (p: string, b?: unknown) => Promise<Response> } },
    vaultId: string,
    userId: string,
    role: string,
    keyVersion = 1,
  ) {
    return actor.client.post(`/api/vaults/${vaultId}/members`, {
      userId,
      role,
      keyVersion,
      sealedKey: sealed(),
    });
  }

  it("owner and manager invite; the member starts pending without a sealed key in the response", async () => {
    const t = await vaultWithRoles();
    const guest = await createUser();
    const res = await invite(t.manager, t.vault.id, guest.id, "editor");
    expect(res.status).toBe(201);
    const { member } = parseWith(inviteMemberResponseSchema, await body(res));
    expect(member).toMatchObject({
      userId: guest.id,
      email: guest.email,
      publicKey: guest.publicKey,
      role: "editor",
      status: "pending",
      keyVersion: 1,
      invitedBy: t.manager.user.id,
    });
    expect(member.sealedKey).toBeUndefined();
  });

  it("enforces the role matrix for inviting", async () => {
    const t = await vaultWithRoles();
    const [a, b, c, d, e] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    expect((await invite(t.editor, t.vault.id, a.id, "viewer")).status).toBe(403);
    expect((await invite(t.viewer, t.vault.id, b.id, "viewer")).status).toBe(403);
    expect((await invite(t.outsider, t.vault.id, c.id, "viewer")).status).toBe(404);
    // A manager cannot add managers; the owner can.
    expect((await invite(t.manager, t.vault.id, d.id, "manager")).status).toBe(403);
    expect((await invite(t.owner, t.vault.id, e.id, "manager")).status).toBe(201);
  });

  it("rejects duplicates, disabled or unknown users, self, stale key versions and bad roles", async () => {
    const t = await vaultWithRoles();
    const guest = await createUser();
    expect((await invite(t.owner, t.vault.id, guest.id, "viewer")).status).toBe(201);
    const dup = await invite(t.owner, t.vault.id, guest.id, "editor");
    expect(dup.status).toBe(409);
    expect((await body<ErrorBody>(dup)).error.code).toBe("conflict");
    // An existing active member too.
    expect((await invite(t.owner, t.vault.id, t.viewer.user.id, "editor")).status).toBe(409);

    const disabled = await createUser({ status: "disabled" });
    expect((await invite(t.owner, t.vault.id, disabled.id, "viewer")).status).toBe(404);
    expect((await invite(t.owner, t.vault.id, uuid(), "viewer")).status).toBe(404);
    expect((await invite(t.owner, t.vault.id, t.owner.user.id, "viewer")).status).toBe(409);

    const other = await createUser();
    const stale = await invite(t.owner, t.vault.id, other.id, "viewer", 2);
    expect(stale.status).toBe(409);
    expect((await body<ErrorBody>(stale)).error.code).toBe("key_version_mismatch");
    expect((await invite(t.owner, t.vault.id, other.id, "owner")).status).toBe(400);
  });

  it("blocks invites while a rotation is pending", async () => {
    const t = await vaultWithRoles();
    await db.update(vaults).set({ rotationPending: true }).where(eq(vaults.id, t.vault.id));
    const guest = await createUser();
    const res = await invite(t.owner, t.vault.id, guest.id, "viewer");
    expect(res.status).toBe(409);
    expect((await body<ErrorBody>(res)).error.code).toBe("rotation_pending");
  });

  it("changes roles within the rules", async () => {
    const t = await vaultWithRoles();
    const path = (memberId: string) => `/api/vaults/${t.vault.id}/members/${memberId}`;

    const res = await t.manager.client.patch(path(t.viewer.member.id), { role: "editor" });
    expect(res.status).toBe(200);
    const { member } = parseWith(updateMemberResponseSchema, await body(res));
    expect(member).toMatchObject({ id: t.viewer.member.id, role: "editor" });
    expect(member.sealedKey).toBeUndefined();

    // A manager cannot touch managers or promote to manager.
    expect(
      (await t.manager.client.patch(path(t.manager.member.id), { role: "viewer" })).status,
    ).toBe(403);
    expect(
      (await t.manager.client.patch(path(t.editor.member.id), { role: "manager" })).status,
    ).toBe(403);
    // Nobody changes the owner's role.
    expect((await t.owner.client.patch(path(t.owner.member.id), { role: "viewer" })).status).toBe(
      403,
    );
    expect((await t.manager.client.patch(path(t.owner.member.id), { role: "viewer" })).status).toBe(
      403,
    );
    // The owner can promote and demote managers.
    expect((await t.owner.client.patch(path(t.editor.member.id), { role: "manager" })).status).toBe(
      200,
    );
    expect((await t.owner.client.patch(path(t.manager.member.id), { role: "viewer" })).status).toBe(
      200,
    );
    // Lower roles and outsiders cannot.
    expect((await t.editor.client.patch(path(t.viewer.member.id), { role: "viewer" })).status).toBe(
      200,
    );
    const denied = await t.viewer.client.patch(path(t.editor.member.id), { role: "viewer" });
    expect(denied.status).toBe(403);
    expect(
      (await t.outsider.client.patch(path(t.viewer.member.id), { role: "viewer" })).status,
    ).toBe(404);
    // Unknown member in this vault.
    expect((await t.owner.client.patch(path(uuid()), { role: "viewer" })).status).toBe(404);
  });

  it("removes a member: row deleted, rotation pending, tombstones for the removed user and the others", async () => {
    const t = await vaultWithRoles();
    const res = await t.manager.client.delete(
      `/api/vaults/${t.vault.id}/members/${t.editor.member.id}`,
    );
    expect(res.status).toBe(200);
    expect(parseWith(removeMemberResponseSchema, await body(res))).toEqual({
      ok: true,
      rotationPending: true,
    });

    const [vault] = await db.select().from(vaults).where(eq(vaults.id, t.vault.id));
    expect(vault?.rotationPending).toBe(true);
    expect(
      await db.select().from(vaultMembers).where(eq(vaultMembers.id, t.editor.member.id)),
    ).toHaveLength(0);

    const vaultTombstone = await db
      .select()
      .from(deletions)
      .where(and(eq(deletions.entity, "vault"), eq(deletions.userId, t.editor.user.id)));
    expect(vaultTombstone).toHaveLength(1);
    const memberTombstone = await db
      .select()
      .from(deletions)
      .where(eq(deletions.entity, "vault_member"));
    expect(memberTombstone).toHaveLength(1);
    expect(memberTombstone[0]).toMatchObject({
      entityId: t.editor.member.id,
      vaultId: t.vault.id,
      userId: null,
    });

    // The removed member lost all access.
    const after = await t.editor.client.patch(`/api/vaults/${t.vault.id}`, {
      keyVersion: 1,
      encryptedMeta: meta(),
    });
    expect(after.status).toBe(404);
  });

  it("enforces who may remove whom", async () => {
    const t = await vaultWithRoles();
    const path = (memberId: string) => `/api/vaults/${t.vault.id}/members/${memberId}`;
    expect((await t.editor.client.delete(path(t.viewer.member.id))).status).toBe(403);
    expect((await t.viewer.client.delete(path(t.viewer.member.id))).status).toBe(403);
    expect((await t.outsider.client.delete(path(t.viewer.member.id))).status).toBe(404);
    expect((await t.manager.client.delete(path(t.owner.member.id))).status).toBe(403);
    expect((await t.owner.client.delete(path(t.owner.member.id))).status).toBe(403);
    expect((await t.manager.client.delete(path(t.manager.member.id))).status).toBe(403);
    expect((await t.owner.client.delete(path(uuid()))).status).toBe(404);
    // A manager cannot remove another manager, the owner can.
    const second = await signedInClient();
    const secondMember = await addMember(t.vault, second.user, "manager");
    expect((await t.manager.client.delete(path(secondMember.id))).status).toBe(403);
    expect((await t.owner.client.delete(path(secondMember.id))).status).toBe(200);
  });

  it("removing a pending invitee also requires a rotation", async () => {
    const t = await vaultWithRoles();
    const guest = await createUser();
    const pending = await addMember(t.vault, guest, "viewer", { status: "pending" });
    const res = await t.owner.client.delete(`/api/vaults/${t.vault.id}/members/${pending.id}`);
    expect(res.status).toBe(200);
    expect((await body<{ rotationPending: boolean }>(res)).rotationPending).toBe(true);
  });

  it("lets non-owners leave without a rotation, but not the owner", async () => {
    const t = await vaultWithRoles();
    const res = await t.viewer.client.post(`/api/vaults/${t.vault.id}/leave`, {});
    expect(res.status).toBe(200);
    parseWith(leaveVaultResponseSchema, await body(res));
    const [vault] = await db.select().from(vaults).where(eq(vaults.id, t.vault.id));
    expect(vault?.rotationPending).toBe(false);
    expect(
      await db.select().from(vaultMembers).where(eq(vaultMembers.id, t.viewer.member.id)),
    ).toHaveLength(0);
    const tombstones = await db.select().from(deletions);
    expect(tombstones.map((row) => `${row.entity}:${row.userId ?? "-"}`).sort()).toEqual(
      [`vault:${t.viewer.user.id}`, "vault_member:-"].sort(),
    );

    // Gone for good, and an empty body is fine as is, but a body with fields is not.
    expect((await t.viewer.client.post(`/api/vaults/${t.vault.id}/leave`, {})).status).toBe(404);
    expect((await t.editor.client.post(`/api/vaults/${t.vault.id}/leave`, { x: 1 })).status).toBe(
      400,
    );
    const owner = await t.owner.client.post(`/api/vaults/${t.vault.id}/leave`);
    expect(owner.status).toBe(409);
  });

  it("treats pending members like outsiders for vault reads and writes", async () => {
    const owner = await signedInClient();
    const guest = await signedInClient();
    const { vault } = await createVaultWithOwner(owner.user);
    await addMember(vault, guest.user, "editor", { status: "pending" });
    const res = await guest.client.patch(`/api/vaults/${vault.id}`, {
      keyVersion: 1,
      encryptedMeta: meta(),
    });
    expect(res.status).toBe(404);
  });
});
