import {
  acceptShareResponseSchema,
  declineShareResponseSchema,
  pendingSharesResponseSchema,
  revokeItemShareResponseSchema,
  shareItemResponseSchema,
  syncResponseSchema,
  updateItemResponseSchema,
} from "@pm/shared";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deletions, itemShares, vaultMembers } from "../src/db/schema.ts";
import {
  createItem,
  createUser,
  createVaultWithOwner,
  db,
  resetDb,
  signedInClient,
} from "./helpers.ts";
import {
  addMember,
  body,
  parseWith,
  sealed,
  updateItemBody,
  uuid,
  vaultWithRoles,
  wrapped,
} from "./vault-helpers.ts";

type ErrorBody = { error: { code: string; details?: Record<string, unknown> } };

async function sync(client: { get: (p: string) => Promise<Response> }, since?: number) {
  const res = await client.get(since === undefined ? "/api/sync" : `/api/sync?since=${since}`);
  expect(res.status).toBe(200);
  return parseWith(syncResponseSchema, await body(res));
}

describe("vault invitations: pending, accept, decline", () => {
  beforeEach(resetDb);

  async function inviteGuest(role: "viewer" | "editor" | "manager" = "editor") {
    const t = await vaultWithRoles();
    const guest = await signedInClient();
    const sealedKey = sealed();
    const res = await t.manager.client.post(`/api/vaults/${t.vault.id}/members`, {
      userId: guest.user.id,
      role: role === "manager" ? "editor" : role,
      keyVersion: 1,
      sealedKey,
    });
    expect(res.status).toBe(201);
    const { member } = await body<{ member: { id: string } }>(res);
    return { ...t, guest, membershipId: member.id, sealedKey };
  }

  it("lists my pending invitations with inviter email and the sealed key", async () => {
    const t = await inviteGuest("viewer");
    const res = await t.guest.client.get("/api/shares/pending");
    expect(res.status).toBe(200);
    const { shares } = parseWith(pendingSharesResponseSchema, await body(res));
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      kind: "vault",
      id: t.membershipId,
      vaultId: t.vault.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: t.sealedKey,
      invitedBy: t.manager.user.id,
      invitedByEmail: t.manager.user.email,
      encryptedMeta: t.vault.encryptedMeta,
    });

    // Not visible to anyone else, nor in the inviter's own list.
    expect(
      parseWith(
        pendingSharesResponseSchema,
        await body(await t.manager.client.get("/api/shares/pending")),
      ).shares,
    ).toEqual([]);
  });

  it("a pending invitation is not in sync until accepted; then the vault appears", async () => {
    const t = await inviteGuest("editor");
    const before = await sync(t.guest.client);
    expect(before.vaults).toEqual([]);
    expect(before.members).toEqual([]);

    const accept = await t.guest.client.post(`/api/shares/${t.membershipId}/accept`, {});
    expect(accept.status).toBe(200);
    parseWith(acceptShareResponseSchema, await body(accept));

    const after = await sync(t.guest.client);
    expect(after.vaults).toHaveLength(1);
    expect(after.vaults[0]).toMatchObject({ id: t.vault.id, myRole: "editor" });
    // Everyone is listed; only my row has a sealed key.
    expect(after.members).toHaveLength(5);
    const own = after.members.find((m) => m.userId === t.guest.user.id);
    expect(own).toMatchObject({ status: "active", sealedKey: t.sealedKey });
    for (const other of after.members.filter((m) => m.userId !== t.guest.user.id)) {
      expect(other.sealedKey).toBeUndefined();
    }
    expect(
      parseWith(
        pendingSharesResponseSchema,
        await body(await t.guest.client.get("/api/shares/pending")),
      ).shares,
    ).toEqual([]);

    // Accepting twice is idempotent.
    expect((await t.guest.client.post(`/api/shares/${t.membershipId}/accept`, {})).status).toBe(
      200,
    );
  });

  it("the accepted member can then write according to the role", async () => {
    const t = await inviteGuest("editor");
    await t.guest.client.post(`/api/shares/${t.membershipId}/accept`, {});
    const res = await t.guest.client.post("/api/items", {
      id: uuid(),
      vaultId: t.vault.id,
      itemKeyVersion: 1,
      wrappedKey: wrapped(),
      vaultKeyVersion: 1,
      encryptedData: sealed(),
    });
    expect(res.status).toBe(201);
  });

  it("declining deletes the row and lets the vault's members drop the pending entry", async () => {
    const t = await inviteGuest("viewer");
    const decline = await t.guest.client.post(`/api/shares/${t.membershipId}/decline`, {});
    expect(decline.status).toBe(200);
    parseWith(declineShareResponseSchema, await body(decline));
    expect(
      await db.select().from(vaultMembers).where(eq(vaultMembers.id, t.membershipId)),
    ).toHaveLength(0);

    const tombstone = await db.select().from(deletions);
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]).toMatchObject({
      entity: "vault_member",
      entityId: t.membershipId,
      vaultId: t.vault.id,
      userId: null,
    });
    // The declined invitee has no access, and cannot decline an unknown or foreign id.
    expect((await t.guest.client.post(`/api/shares/${t.membershipId}/decline`, {})).status).toBe(
      404,
    );
    expect((await t.guest.client.post(`/api/shares/${uuid()}/accept`, {})).status).toBe(404);
  });

  it("only the addressee can answer an invitation; active memberships cannot be declined", async () => {
    const t = await inviteGuest("viewer");
    expect((await t.outsider.client.post(`/api/shares/${t.membershipId}/accept`, {})).status).toBe(
      404,
    );
    expect((await t.manager.client.post(`/api/shares/${t.membershipId}/accept`, {})).status).toBe(
      404,
    );
    expect((await t.outsider.client.post(`/api/shares/${t.membershipId}/decline`, {})).status).toBe(
      404,
    );
    // Declining an active membership is not possible (use leave).
    expect(
      (await t.viewer.client.post(`/api/shares/${t.viewer.member.id}/decline`, {})).status,
    ).toBe(404);
    expect(
      await db.select().from(vaultMembers).where(eq(vaultMembers.id, t.viewer.member.id)),
    ).toHaveLength(1);
  });

  it("refuses to accept a sealed key for an old key version", async () => {
    const owner = await signedInClient();
    const guest = await signedInClient();
    const { vault } = await createVaultWithOwner(owner.user, { keyVersion: 2 });
    const stale = await addMember(vault, guest.user, "viewer", {
      status: "pending",
      keyVersion: 1,
      invitedBy: owner.user.id,
    });
    const res = await guest.client.post(`/api/shares/${stale.id}/accept`, {});
    expect(res.status).toBe(409);
    expect((await body<ErrorBody>(res)).error.code).toBe("key_version_mismatch");
  });

  it("skips invitations whose inviter no longer exists", async () => {
    const owner = await signedInClient();
    const guest = await signedInClient();
    const { vault } = await createVaultWithOwner(owner.user);
    await addMember(vault, guest.user, "viewer", { status: "pending" });
    const res = await guest.client.get("/api/shares/pending");
    expect(parseWith(pendingSharesResponseSchema, await body(res)).shares).toEqual([]);
  });
});

describe("single-item shares for a non-member", () => {
  beforeEach(resetDb);

  async function setup() {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const guest = await signedInClient();
    return { ...t, item, guest };
  }

  async function share(
    t: Awaited<ReturnType<typeof setup>>,
    actor: { client: { post: (p: string, b?: unknown) => Promise<Response> } },
    role: "viewer" | "editor" = "editor",
    keyVersion = 1,
  ) {
    return actor.client.post(`/api/items/${t.item.id}/shares`, {
      userId: t.guest.user.id,
      role,
      keyVersion,
      sealedKey: sealed(),
    });
  }

  it("share -> pending -> accept -> the item shows up in sync, editable by an editor share", async () => {
    const t = await setup();
    const res = await share(t, t.manager);
    expect(res.status).toBe(201);
    const { share: created } = parseWith(shareItemResponseSchema, await body(res));
    expect(created).toMatchObject({
      itemId: t.item.id,
      vaultId: t.vault.id,
      userId: t.guest.user.id,
      email: t.guest.user.email,
      role: "editor",
      status: "pending",
      keyVersion: 1,
      invitedBy: t.manager.user.id,
    });
    expect(created.sealedKey).toBeUndefined();

    // Pending: listed as an invitation, invisible in sync.
    const pending = parseWith(
      pendingSharesResponseSchema,
      await body(await t.guest.client.get("/api/shares/pending")),
    );
    expect(pending.shares).toHaveLength(1);
    expect(pending.shares[0]).toMatchObject({
      kind: "item",
      id: created.id,
      itemId: t.item.id,
      vaultId: t.vault.id,
      role: "editor",
      invitedByEmail: t.manager.user.email,
    });
    const hidden = await sync(t.guest.client);
    expect(hidden.items).toEqual([]);
    expect(hidden.itemShares).toEqual([]);

    expect((await t.guest.client.post(`/api/shares/${created.id}/accept`, {})).status).toBe(200);
    const visible = await sync(t.guest.client);
    expect(visible.vaults).toEqual([]);
    expect(visible.items.map((i) => i.id)).toEqual([t.item.id]);
    expect(visible.itemShares).toHaveLength(1);
    expect(visible.itemShares[0]?.sealedKey).toBeDefined();

    // Members of the vault see the share without its sealed key.
    const members = await sync(t.editor.client);
    const listed = members.itemShares.find((s) => s.id === created.id);
    expect(listed).toMatchObject({ status: "active", email: t.guest.user.email });
    expect(listed?.sealedKey).toBeUndefined();

    // The editor recipient can save changes.
    const update = await t.guest.client.put(`/api/items/${t.item.id}`, updateItemBody(t.item));
    expect(update.status).toBe(200);
    parseWith(updateItemResponseSchema, await body(update));
  });

  it("is manager+ only, and only for active, non-member users without a share yet", async () => {
    const t = await setup();
    expect((await share(t, t.editor)).status).toBe(403);
    expect((await share(t, t.viewer)).status).toBe(403);
    expect((await share(t, t.outsider)).status).toBe(404);

    const stale = await share(t, t.manager, "viewer", 2);
    expect(stale.status).toBe(409);
    expect((await body<ErrorBody>(stale)).error.code).toBe("key_version_mismatch");

    expect((await share(t, t.manager)).status).toBe(201);
    const dup = await share(t, t.owner);
    expect(dup.status).toBe(409);
    expect((await body<ErrorBody>(dup)).error.code).toBe("conflict");

    // Existing vault members (any status) cannot get an item share.
    const asMember = await t.manager.client.post(`/api/items/${t.item.id}/shares`, {
      userId: t.viewer.user.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed(),
    });
    expect(asMember.status).toBe(409);
    // Unknown and disabled users, and yourself.
    const ghost = await createUser({ status: "disabled" });
    for (const userId of [uuid(), ghost.id]) {
      const r = await t.manager.client.post(`/api/items/${t.item.id}/shares`, {
        userId,
        role: "viewer",
        keyVersion: 1,
        sealedKey: sealed(),
      });
      expect(r.status).toBe(404);
    }
    const self = await t.manager.client.post(`/api/items/${t.item.id}/shares`, {
      userId: t.manager.user.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed(),
    });
    expect(self.status).toBe(400);
  });

  it("revoking leaves tombstones for the recipient and the members; the key rotation then needs all remaining shares", async () => {
    const t = await setup();
    const other = await signedInClient();
    const created = parseWith(
      shareItemResponseSchema,
      await body(await share(t, t.manager, "viewer")),
    );
    const second = parseWith(
      shareItemResponseSchema,
      await body(
        await t.manager.client.post(`/api/items/${t.item.id}/shares`, {
          userId: other.user.id,
          role: "viewer",
          keyVersion: 1,
          sealedKey: sealed(),
        }),
      ),
    );
    await t.guest.client.post(`/api/shares/${created.share.id}/accept`, {});

    expect(
      (await t.editor.client.delete(`/api/items/${t.item.id}/shares/${created.share.id}`)).status,
    ).toBe(403);
    expect(
      (await t.outsider.client.delete(`/api/items/${t.item.id}/shares/${created.share.id}`)).status,
    ).toBe(404);
    expect((await t.manager.client.delete(`/api/items/${t.item.id}/shares/${uuid()}`)).status).toBe(
      404,
    );

    const res = await t.manager.client.delete(`/api/items/${t.item.id}/shares/${created.share.id}`);
    expect(res.status).toBe(200);
    parseWith(revokeItemShareResponseSchema, await body(res));
    expect(
      await db.select().from(itemShares).where(eq(itemShares.id, created.share.id)),
    ).toHaveLength(0);

    const tombstones = await db
      .select()
      .from(deletions)
      .where(and(eq(deletions.entity, "item_share"), eq(deletions.entityId, created.share.id)));
    expect(
      tombstones.map((row) => row.userId).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([null, t.guest.user.id].sort((a, b) => String(a).localeCompare(String(b))));
    expect(tombstones.every((row) => row.vaultId === t.vault.id)).toBe(true);

    // The revoked recipient lost access.
    expect(
      (await t.guest.client.put(`/api/items/${t.item.id}`, updateItemBody(t.item))).status,
    ).toBe(404);

    // Rotating the item key: the remaining share must be re-sealed.
    const missing = await t.editor.client.put(
      `/api/items/${t.item.id}`,
      updateItemBody(t.item, { itemKeyVersion: 2, wrappedKey: wrapped() }),
    );
    expect(missing.status).toBe(409);
    const ok = await t.editor.client.put(
      `/api/items/${t.item.id}`,
      updateItemBody(t.item, {
        itemKeyVersion: 2,
        wrappedKey: wrapped(),
        shareKeys: [{ shareId: second.share.id, sealedKey: sealed() }],
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("a recipient can remove their own share", async () => {
    const t = await setup();
    const created = parseWith(
      shareItemResponseSchema,
      await body(await share(t, t.manager, "viewer")),
    );
    await t.guest.client.post(`/api/shares/${created.share.id}/accept`, {});
    const res = await t.guest.client.delete(`/api/items/${t.item.id}/shares/${created.share.id}`);
    expect(res.status).toBe(200);
    expect(await db.select().from(itemShares)).toHaveLength(0);
  });

  it("declining an item share deletes it", async () => {
    const t = await setup();
    const created = parseWith(
      shareItemResponseSchema,
      await body(await share(t, t.manager, "viewer")),
    );
    const res = await t.guest.client.post(`/api/shares/${created.share.id}/decline`, {});
    expect(res.status).toBe(200);
    expect(await db.select().from(itemShares)).toHaveLength(0);
    const rows = await db.select().from(deletions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: "item_share",
      entityId: created.share.id,
      userId: null,
      vaultId: t.vault.id,
    });
  });

  it("is blocked while a rotation is pending", async () => {
    const t = await setup();
    const { vaults } = await import("../src/db/schema.ts");
    await db.update(vaults).set({ rotationPending: true }).where(eq(vaults.id, t.vault.id));
    const res = await share(t, t.manager);
    expect(res.status).toBe(409);
    expect((await body<ErrorBody>(res)).error.code).toBe("rotation_pending");
  });
});
