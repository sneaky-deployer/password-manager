import { syncResponseSchema } from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deletions, itemShares, items } from "../src/db/schema.ts";
import { SYNC_OVERLAP_MS } from "../src/routes/sync.ts";
import { createItem, createVaultWithOwner, db, resetDb, signedInClient } from "./helpers.ts";
import {
  addMember,
  backdateAll,
  body,
  parseWith,
  sealed,
  uuid,
  vaultWithRoles,
  wrapped,
} from "./vault-helpers.ts";

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];

async function sync(client: Client, since?: number) {
  const res = await client.get(since === undefined ? "/api/sync" : `/api/sync?since=${since}`);
  expect(res.status).toBe(200);
  return parseWith(syncResponseSchema, await body(res));
}

const DAY = 24 * 60 * 60 * 1000;

describe("GET /api/sync, full", () => {
  beforeEach(resetDb);

  it("requires a session and a numeric since", async () => {
    const { client } = await signedInClient();
    expect((await client.get("/api/sync?since=abc")).status).toBe(400);
    expect((await client.get("/api/sync?since=-5")).status).toBe(400);
    client.jar.clear();
    expect((await client.get("/api/sync")).status).toBe(401);
  });

  it("returns my vaults, their members, items (trashed too) and nothing else", async () => {
    const t = await vaultWithRoles();
    const live = await createItem(t.vault, t.owner.user);
    const trashed = await createItem(t.vault, t.owner.user, { trashedAt: Date.now() });
    // Someone else's vault must not leak.
    const stranger = await signedInClient();
    const { vault: foreign } = await createVaultWithOwner(stranger.user);
    await createItem(foreign, stranger.user);

    const before = Date.now();
    const res = await sync(t.editor.client);
    expect(res.full).toBe(true);
    expect(res.deletions).toEqual([]);
    expect(res.serverTime).toBeGreaterThanOrEqual(before - 1000);
    expect(res.serverTime).toBeLessThanOrEqual(Date.now());
    expect(res.vaults.map((v) => v.id)).toEqual([t.vault.id]);
    expect(res.vaults[0]?.myRole).toBe("editor");
    expect(res.items.map((i) => i.id).sort()).toEqual([live.id, trashed.id].sort());
    expect(res.items.find((i) => i.id === trashed.id)?.trashedAt).not.toBeNull();

    expect(res.members).toHaveLength(4);
    for (const member of res.members) {
      const user = [t.owner, t.manager, t.editor, t.viewer].find(
        (a) => a.user.id === member.userId,
      );
      expect(member.email).toBe(user?.user.email);
      expect(member.publicKey).toBe(user?.user.publicKey);
      if (member.userId === t.editor.user.id)
        expect(member.sealedKey).toBe(t.editor.member.sealedKey);
      else expect(member.sealedKey).toBeUndefined();
    }
    // Outsiders get an empty snapshot.
    const empty = await sync(t.outsider.client);
    expect(empty).toMatchObject({ full: true, vaults: [], members: [], items: [], itemShares: [] });
  });

  it("lists pending members of my vaults (without keys) but not my own pending invitations", async () => {
    const t = await vaultWithRoles();
    const guest = await signedInClient();
    await addMember(t.vault, guest.user, "viewer", { status: "pending" });
    const other = await createVaultWithOwner((await signedInClient()).user);
    await addMember(other.vault, t.editor.user, "viewer", { status: "pending" });

    const res = await sync(t.manager.client);
    const pending = res.members.filter((m) => m.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.userId).toBe(guest.user.id);
    expect(pending[0]?.sealedKey).toBeUndefined();
    // My own pending invitation to another vault is not part of sync.
    const mine = await sync(t.editor.client);
    expect(mine.vaults.map((v) => v.id)).toEqual([t.vault.id]);
  });

  it("includes items shared with me individually (active only) and the other shares of my vaults", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const recipient = await signedInClient();
    const pendingRecipient = await signedInClient();
    const now = Date.now();
    const makeShare = async (userId: string, status: "pending" | "active", itemId = item.id) => {
      const [row] = await db
        .insert(itemShares)
        .values({
          id: uuid(),
          itemId,
          userId,
          role: "viewer",
          keyVersion: 1,
          sealedKey: sealed(),
          status,
          invitedBy: t.owner.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("no share");
      return row;
    };
    const active = await makeShare(recipient.user.id, "active");
    const pending = await makeShare(pendingRecipient.user.id, "pending");

    const asRecipient = await sync(recipient.client);
    expect(asRecipient.vaults).toEqual([]);
    expect(asRecipient.items.map((i) => i.id)).toEqual([item.id]);
    expect(asRecipient.itemShares).toHaveLength(1);
    expect(asRecipient.itemShares[0]).toMatchObject({
      id: active.id,
      vaultId: t.vault.id,
      sealedKey: active.sealedKey,
    });

    const asPending = await sync(pendingRecipient.client);
    expect(asPending.items).toEqual([]);
    expect(asPending.itemShares).toEqual([]);

    const asMember = await sync(t.viewer.client);
    expect(asMember.items.map((i) => i.id)).toEqual([item.id]); // once, not twice
    expect(asMember.itemShares.map((s) => s.id).sort()).toEqual([active.id, pending.id].sort());
    for (const share of asMember.itemShares) {
      expect(share.sealedKey).toBeUndefined();
      expect(share.publicKey).toBeDefined();
    }
  });

  it("a user who is both vault member and share recipient gets the item once, with their own sealed key", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const now = Date.now();
    const sealedKey = sealed();
    await db.insert(itemShares).values({
      id: uuid(),
      itemId: item.id,
      userId: t.viewer.user.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey,
      status: "active",
      invitedBy: t.owner.user.id,
      createdAt: now,
      updatedAt: now,
    });
    const res = await sync(t.viewer.client);
    expect(res.items).toHaveLength(1);
    expect(res.itemShares).toHaveLength(1);
    expect(res.itemShares[0]?.sealedKey).toBe(sealedKey);
  });

  it("does a full sync when since is older than the tombstone retention", async () => {
    const t = await vaultWithRoles();
    await db.insert(deletions).values({
      id: uuid(),
      entity: "item",
      entityId: uuid(),
      vaultId: t.vault.id,
      userId: null,
      deletedAt: Date.now() - 10 * DAY,
    });
    const old = await sync(t.viewer.client, Date.now() - 91 * DAY);
    expect(old.full).toBe(true);
    expect(old.deletions).toEqual([]);
    const recent = await sync(t.viewer.client, Date.now() - 30 * DAY);
    expect(recent.full).toBe(false);
    expect(recent.deletions).toHaveLength(1);
  });
});

describe("GET /api/sync, incremental", () => {
  beforeEach(resetDb);

  it("only returns rows changed after since (with a small overlap), and bumps on every change", async () => {
    const t = await vaultWithRoles();
    const quiet = await createItem(t.vault, t.owner.user);
    const busy = await createItem(t.vault, t.owner.user);
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;

    const nothing = await sync(t.viewer.client, since);
    expect(nothing).toMatchObject({
      full: false,
      vaults: [],
      members: [],
      items: [],
      itemShares: [],
      deletions: [],
    });

    // An edit moves only that item into the delta.
    const update = await t.editor.client.put(`/api/items/${busy.id}`, {
      itemKeyVersion: 1,
      wrappedKey: busy.wrappedKey,
      vaultKeyVersion: 1,
      encryptedData: sealed(),
      revision: 1,
    });
    expect(update.status).toBe(200);
    const delta = await sync(t.viewer.client, since);
    expect(delta.items.map((i) => i.id)).toEqual([busy.id]);
    expect(delta.items[0]?.revision).toBe(2);
    expect(delta.items.some((i) => i.id === quiet.id)).toBe(false);

    // Trash and restore are visible, too.
    await t.editor.client.post(`/api/items/${quiet.id}/trash`, {});
    const trashedDelta = await sync(t.viewer.client, since);
    expect(trashedDelta.items.find((i) => i.id === quiet.id)?.trashedAt).not.toBeNull();
  });

  it("repeats changes from the last SYNC_OVERLAP_MS before since (concurrent-writer safety)", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const stamp = Date.now() - 5000;
    await db.update(items).set({ updatedAt: stamp }).where(eq(items.id, item.id));
    // since is just after the change, but within the overlap window.
    expect((await sync(t.viewer.client, stamp + SYNC_OVERLAP_MS - 1)).items).toHaveLength(1);
    expect((await sync(t.viewer.client, stamp + SYNC_OVERLAP_MS + 1)).items).toHaveLength(0);
  });

  it("a role change re-sends the vault with the new myRole", async () => {
    const t = await vaultWithRoles();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    const res = await t.owner.client.patch(
      `/api/vaults/${t.vault.id}/members/${t.viewer.member.id}`,
      { role: "editor" },
    );
    expect(res.status).toBe(200);
    const delta = await sync(t.viewer.client, since);
    expect(delta.vaults).toHaveLength(1);
    expect(delta.vaults[0]?.myRole).toBe("editor");
    // Everyone sees the changed member row.
    const others = await sync(t.manager.client, since);
    expect(others.members.map((m) => m.id)).toContain(t.viewer.member.id);
  });

  it("a newly accepted vault arrives complete: vault, all members, all old items", async () => {
    const t = await vaultWithRoles();
    const old = await createItem(t.vault, t.owner.user);
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const guest = await signedInClient();
    const invite = await t.owner.client.post(`/api/vaults/${t.vault.id}/members`, {
      userId: guest.user.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed(),
    });
    const { member } = await body<{ member: { id: string } }>(invite);
    await guest.client.post(`/api/shares/${member.id}/accept`, {});

    const since = Date.now() - 30 * 60 * 1000; // before the accept, after all the old data
    const delta = await sync(guest.client, since);
    expect(delta.vaults.map((v) => v.id)).toEqual([t.vault.id]);
    expect(delta.members).toHaveLength(5);
    expect(delta.items.map((i) => i.id)).toEqual([old.id]);
  });

  it("key rotation bumps everything it touches", async () => {
    // Covered in rotation.test.ts; here just the vault-level signal from removal.
    const t = await vaultWithRoles();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    await t.owner.client.delete(`/api/vaults/${t.vault.id}/members/${t.editor.member.id}`);
    const delta = await sync(t.viewer.client, since);
    expect(delta.vaults[0]?.rotationPending).toBe(true);
  });
});

describe("tombstones", () => {
  beforeEach(resetDb);

  it("member removal: the removed user drops the vault, the others drop the member", async () => {
    const t = await vaultWithRoles();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    const res = await t.owner.client.delete(
      `/api/vaults/${t.vault.id}/members/${t.editor.member.id}`,
    );
    expect(res.status).toBe(200);

    const removed = await sync(t.editor.client, since);
    expect(removed.deletions).toEqual([
      expect.objectContaining({ entity: "vault", id: t.vault.id }),
    ]);
    expect(removed.vaults).toEqual([]);
    expect(removed.items).toEqual([]);

    const others = await sync(t.viewer.client, since);
    expect(others.deletions).toEqual([
      expect.objectContaining({ entity: "vault_member", id: t.editor.member.id }),
    ]);

    const outsider = await sync(t.outsider.client, since);
    expect(outsider.deletions).toEqual([]);
  });

  it("leaving works the same way", async () => {
    const t = await vaultWithRoles();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    await t.viewer.client.post(`/api/vaults/${t.vault.id}/leave`, {});
    expect((await sync(t.viewer.client, since)).deletions.map((d) => d.entity)).toEqual(["vault"]);
    expect((await sync(t.manager.client, since)).deletions.map((d) => d.entity)).toEqual([
      "vault_member",
    ]);
  });

  it("a deleted vault tells every member, and share recipients drop their shares", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const recipient = await signedInClient();
    const now = Date.now();
    const [share] = await db
      .insert(itemShares)
      .values({
        id: uuid(),
        itemId: item.id,
        userId: recipient.user.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: sealed(),
        status: "active",
        invitedBy: t.owner.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    await t.owner.client.delete(`/api/vaults/${t.vault.id}`);

    for (const actor of [t.owner, t.manager, t.editor, t.viewer]) {
      const res = await sync(actor.client, since);
      expect(res.deletions).toEqual([expect.objectContaining({ entity: "vault", id: t.vault.id })]);
    }
    const shared = await sync(recipient.client, since);
    expect(shared.deletions).toEqual([
      expect.objectContaining({ entity: "item_share", id: share?.id }),
    ]);
    expect((await sync(t.outsider.client, since)).deletions).toEqual([]);
  });

  it("a permanently deleted item is announced to the members, and its share to the recipient", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user, { trashedAt: Date.now() });
    const recipient = await signedInClient();
    const now = Date.now();
    const [share] = await db
      .insert(itemShares)
      .values({
        id: uuid(),
        itemId: item.id,
        userId: recipient.user.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: sealed(),
        status: "active",
        invitedBy: t.owner.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    expect((await t.editor.client.delete(`/api/items/${item.id}`)).status).toBe(200);

    const members = await sync(t.viewer.client, since);
    expect(members.deletions).toEqual([expect.objectContaining({ entity: "item", id: item.id })]);
    const shared = await sync(recipient.client, since);
    expect(shared.deletions).toEqual([
      expect.objectContaining({ entity: "item_share", id: share?.id }),
    ]);
    expect((await sync(t.outsider.client, since)).deletions).toEqual([]);
  });

  it("a revoked share is announced to the recipient and to the vault's members", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const recipient = await signedInClient();
    const created = await t.manager.client.post(`/api/items/${item.id}/shares`, {
      userId: recipient.user.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed(),
    });
    const { share } = await body<{ share: { id: string } }>(created);
    await recipient.client.post(`/api/shares/${share.id}/accept`, {});
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    await t.manager.client.delete(`/api/items/${item.id}/shares/${share.id}`);

    const expected = [expect.objectContaining({ entity: "item_share", id: share.id })];
    expect((await sync(recipient.client, since)).deletions).toEqual(expected);
    expect((await sync(t.viewer.client, since)).deletions).toEqual(expected);
    expect((await sync(t.outsider.client, since)).deletions).toEqual([]);
  });

  it("a moved item is announced in the old vault only", async () => {
    const user = await signedInClient();
    const peer = await signedInClient();
    const { vault: source } = await createVaultWithOwner(user.user);
    const { vault: target } = await createVaultWithOwner(user.user);
    await addMember(source, peer.user, "viewer");
    const item = await createItem(source, user.user);
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    const res = await user.client.post(`/api/items/${item.id}/move`, {
      targetVaultId: target.id,
      wrappedKey: wrapped(),
      vaultKeyVersion: 1,
      revision: 1,
    });
    expect(res.status).toBe(200);

    const old = await sync(peer.client, since);
    expect(old.deletions).toEqual([expect.objectContaining({ entity: "item", id: item.id })]);
    expect(old.items).toEqual([]);
    // The owner is in both vaults: gets the tombstone AND the item in its new vault; deletions are
    // applied first by clients.
    const both = await sync(user.client, since);
    expect(both.deletions).toHaveLength(1);
    expect(both.items.map((i) => i.id)).toEqual([item.id]);
    expect(both.items[0]?.vaultId).toBe(target.id);
  });

  it("only returns tombstones newer than since", async () => {
    const t = await vaultWithRoles();
    await db.insert(deletions).values([
      {
        id: uuid(),
        entity: "item",
        entityId: uuid(),
        vaultId: t.vault.id,
        userId: null,
        deletedAt: Date.now() - 20 * DAY,
      },
      {
        id: uuid(),
        entity: "item",
        entityId: uuid(),
        vaultId: t.vault.id,
        userId: null,
        deletedAt: Date.now() - 5 * DAY,
      },
    ]);
    const res = await sync(t.viewer.client, Date.now() - 10 * DAY);
    expect(res.deletions).toHaveLength(1);
  });

  it("does not leak tombstones of vaults the user is no longer in", async () => {
    const t = await vaultWithRoles();
    await db.insert(deletions).values({
      id: uuid(),
      entity: "item",
      entityId: uuid(),
      vaultId: t.vault.id,
      userId: null,
      deletedAt: Date.now(),
    });
    // The editor leaves; afterwards the vault's item tombstones are no business of theirs.
    await t.editor.client.post(`/api/vaults/${t.vault.id}/leave`, {});
    const res = await sync(t.editor.client, Date.now() - DAY);
    expect(res.deletions.map((d) => d.entity)).toEqual(["vault"]);
  });
});
