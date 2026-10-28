import {
  createItemResponseSchema,
  deleteItemResponseSchema,
  moveItemResponseSchema,
  restoreItemResponseSchema,
  trashItemResponseSchema,
  updateItemResponseSchema,
} from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deletions, itemShares, items, vaultMembers, vaults } from "../src/db/schema.ts";
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
  createItemBody,
  envelope,
  parseWith,
  sealed,
  updateItemBody,
  uuid,
  vaultWithRoles,
  wrapped,
} from "./vault-helpers.ts";

type ErrorBody = { error: { code: string; details?: Record<string, unknown> } };

async function errorCode(res: Response): Promise<string> {
  return (await body<ErrorBody>(res)).error.code;
}

describe("POST /api/items", () => {
  beforeEach(resetDb);

  it("creates an item as editor+ with revision 1", async () => {
    const t = await vaultWithRoles();
    for (const actor of [t.owner, t.manager, t.editor]) {
      const res = await actor.client.post("/api/items", createItemBody(t.vault.id));
      expect(res.status).toBe(201);
      const { item } = parseWith(createItemResponseSchema, await body(res));
      expect(item).toMatchObject({
        vaultId: t.vault.id,
        revision: 1,
        trashedAt: null,
        createdBy: actor.user.id,
        updatedBy: actor.user.id,
        vaultKeyVersion: 1,
      });
    }
  });

  it("enforces the role matrix", async () => {
    const t = await vaultWithRoles();
    expect((await t.viewer.client.post("/api/items", createItemBody(t.vault.id))).status).toBe(403);
    expect((await t.outsider.client.post("/api/items", createItemBody(t.vault.id))).status).toBe(
      404,
    );
    const res = await t.editor.client.post("/api/items", createItemBody(uuid()));
    expect(res.status).toBe(404);
  });

  it("rejects duplicate ids, stale key versions and pending rotations", async () => {
    const t = await vaultWithRoles();
    const payload = createItemBody(t.vault.id);
    expect((await t.editor.client.post("/api/items", payload)).status).toBe(201);
    const dup = await t.editor.client.post("/api/items", payload);
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("conflict");

    const stale = await t.editor.client.post("/api/items", createItemBody(t.vault.id, 2));
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("key_version_mismatch");

    await db.update(vaults).set({ rotationPending: true }).where(eq(vaults.id, t.vault.id));
    const pending = await t.editor.client.post("/api/items", createItemBody(t.vault.id));
    expect(pending.status).toBe(409);
    expect(await errorCode(pending)).toBe("rotation_pending");
  });

  it("validates the body and rejects oversized ones", async () => {
    const t = await vaultWithRoles();
    const bad = await t.editor.client.post("/api/items", {
      ...createItemBody(t.vault.id),
      id: "x",
    });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("validation_error");
    // Real requests announce their size; the middleware refuses before reading the body.
    const huge = await t.editor.client.post(
      "/api/items",
      { ...createItemBody(t.vault.id), encryptedData: "A".repeat(150 * 1024) },
      { headers: { "Content-Length": String(200 * 1024) } },
    );
    expect(huge.status).toBe(413);
    expect(await errorCode(huge)).toBe("item_too_large");
  });
});

describe("PUT /api/items/:id", () => {
  beforeEach(resetDb);

  it("updates content, bumps revision and updated_at, records the editor", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user, { updatedAt: 1000, createdAt: 1000 });
    const data = envelope();
    const res = await t.editor.client.put(
      `/api/items/${item.id}`,
      updateItemBody(item, { encryptedData: data }),
    );
    expect(res.status).toBe(200);
    const { item: updated } = parseWith(updateItemResponseSchema, await body(res));
    expect(updated).toMatchObject({
      id: item.id,
      revision: 2,
      encryptedData: data,
      updatedBy: t.editor.user.id,
      createdBy: t.owner.user.id,
    });
    expect(updated.updatedAt).toBeGreaterThan(1000);
  });

  it("returns revision_conflict with the current revision for a stale write", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const first = await t.editor.client.put(`/api/items/${item.id}`, updateItemBody(item));
    expect(first.status).toBe(200);
    const stale = await t.owner.client.put(`/api/items/${item.id}`, updateItemBody(item));
    expect(stale.status).toBe(409);
    const err = await body<ErrorBody>(stale);
    expect(err.error.code).toBe("revision_conflict");
    expect(err.error.details).toMatchObject({ currentRevision: 2 });
  });

  it("enforces roles", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    expect((await t.viewer.client.put(`/api/items/${item.id}`, updateItemBody(item))).status).toBe(
      403,
    );
    expect(
      (await t.outsider.client.put(`/api/items/${item.id}`, updateItemBody(item))).status,
    ).toBe(404);
    expect((await t.owner.client.put(`/api/items/${uuid()}`, updateItemBody(item))).status).toBe(
      404,
    );
  });

  it("rejects a wrong vault key version and pending rotations", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const stale = await t.editor.client.put(
      `/api/items/${item.id}`,
      updateItemBody(item, { vaultKeyVersion: 2 }),
    );
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("key_version_mismatch");

    await db.update(vaults).set({ rotationPending: true }).where(eq(vaults.id, t.vault.id));
    const pending = await t.editor.client.put(`/api/items/${item.id}`, updateItemBody(item));
    expect(pending.status).toBe(409);
    expect(await errorCode(pending)).toBe("rotation_pending");
  });

  it("does not accept an item key bump without the shares re-sealed, and applies both together", async () => {
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
    if (!share) throw new Error("no share");

    const bumped = (extra: object = {}) =>
      updateItemBody(item, { itemKeyVersion: 2, wrappedKey: wrapped(), ...extra });

    const missing = await t.editor.client.put(`/api/items/${item.id}`, bumped());
    expect(missing.status).toBe(409);
    expect((await body<ErrorBody>(missing)).error.details).toMatchObject({
      missingShareIds: [share.id],
    });

    const unknown = await t.editor.client.put(
      `/api/items/${item.id}`,
      bumped({
        shareKeys: [
          { shareId: share.id, sealedKey: sealed() },
          { shareId: uuid(), sealedKey: sealed() },
        ],
      }),
    );
    expect(unknown.status).toBe(400);

    const newSealed = sealed();
    const ok = await t.editor.client.put(
      `/api/items/${item.id}`,
      bumped({ shareKeys: [{ shareId: share.id, sealedKey: newSealed }] }),
    );
    expect(ok.status).toBe(200);
    const { item: updated } = parseWith(updateItemResponseSchema, await body(ok));
    expect(updated.itemKeyVersion).toBe(2);
    const [stored] = await db.select().from(itemShares).where(eq(itemShares.id, share.id));
    expect(stored).toMatchObject({ sealedKey: newSealed, keyVersion: 2 });

    // shareKeys without a new key version make no sense.
    const noBump = await t.editor.client.put(
      `/api/items/${item.id}`,
      updateItemBody(updated, { shareKeys: [{ shareId: share.id, sealedKey: sealed() }] }),
    );
    expect(noBump.status).toBe(400);
    // Skipping a key version is a mismatch.
    const skip = await t.editor.client.put(
      `/api/items/${item.id}`,
      updateItemBody(updated, { itemKeyVersion: 5 }),
    );
    expect(skip.status).toBe(409);
    expect(await errorCode(skip)).toBe("key_version_mismatch");
  });

  it("a stale revision does not apply the share keys either (all or nothing)", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const recipient = await createUser();
    const now = Date.now();
    const oldSealed = sealed();
    const [share] = await db
      .insert(itemShares)
      .values({
        id: uuid(),
        itemId: item.id,
        userId: recipient.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: oldSealed,
        status: "pending",
        invitedBy: t.owner.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!share) throw new Error("no share");
    const res = await t.editor.client.put(
      `/api/items/${item.id}`,
      updateItemBody(item, {
        revision: 7,
        itemKeyVersion: 2,
        shareKeys: [{ shareId: share.id, sealedKey: sealed() }],
      }),
    );
    expect(res.status).toBe(409);
    const [stored] = await db.select().from(itemShares).where(eq(itemShares.id, share.id));
    expect(stored?.sealedKey).toBe(oldSealed);
  });
});

describe("trash, restore and delete", () => {
  beforeEach(resetDb);

  it("trashes and restores as editor+, idempotently, keeping the revision", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const trash = await t.editor.client.post(`/api/items/${item.id}/trash`, {});
    expect(trash.status).toBe(200);
    const { item: trashed } = parseWith(trashItemResponseSchema, await body(trash));
    expect(trashed.trashedAt).not.toBeNull();
    expect(trashed.revision).toBe(item.revision);
    expect(trashed.updatedAt).toBeGreaterThanOrEqual(item.updatedAt);

    const again = await t.editor.client.post(`/api/items/${item.id}/trash`);
    expect(again.status).toBe(200);
    expect(parseWith(trashItemResponseSchema, await body(again)).item.trashedAt).toBe(
      trashed.trashedAt,
    );

    const restore = await t.manager.client.post(`/api/items/${item.id}/restore`, {});
    expect(restore.status).toBe(200);
    expect(parseWith(restoreItemResponseSchema, await body(restore)).item.trashedAt).toBeNull();
  });

  it("denies viewers and outsiders", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    expect((await t.viewer.client.post(`/api/items/${item.id}/trash`, {})).status).toBe(403);
    expect((await t.outsider.client.post(`/api/items/${item.id}/trash`, {})).status).toBe(404);
    expect((await t.viewer.client.post(`/api/items/${item.id}/restore`, {})).status).toBe(403);
    expect((await t.viewer.client.delete(`/api/items/${item.id}`)).status).toBe(403);
  });

  it("only deletes trashed items, then leaves tombstones for members and share recipients", async () => {
    const t = await vaultWithRoles();
    const item = await createItem(t.vault, t.owner.user);
    const recipient = await createUser();
    const now = Date.now();
    const [share] = await db
      .insert(itemShares)
      .values({
        id: uuid(),
        itemId: item.id,
        userId: recipient.id,
        role: "viewer",
        keyVersion: 1,
        sealedKey: sealed(),
        status: "active",
        invitedBy: t.owner.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!share) throw new Error("no share");

    const early = await t.editor.client.delete(`/api/items/${item.id}`);
    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe("conflict");

    await t.editor.client.post(`/api/items/${item.id}/trash`, {});
    const res = await t.editor.client.delete(`/api/items/${item.id}`);
    expect(res.status).toBe(200);
    parseWith(deleteItemResponseSchema, await body(res));

    expect(await db.select().from(items).where(eq(items.id, item.id))).toHaveLength(0);
    expect(await db.select().from(itemShares)).toHaveLength(0);
    const rows = await db.select().from(deletions);
    const itemTombstone = rows.find((row) => row.entity === "item");
    expect(itemTombstone).toMatchObject({
      entityId: item.id,
      vaultId: t.vault.id,
      userId: null,
    });
    const shareTombstone = rows.find((row) => row.entity === "item_share");
    expect(shareTombstone).toMatchObject({ entityId: share.id, userId: recipient.id });
  });
});

describe("POST /api/items/:id/move", () => {
  beforeEach(resetDb);

  it("moves an item between vaults, bumps the revision and tombstones it in the old vault", async () => {
    const user = await signedInClient();
    const { vault: source } = await createVaultWithOwner(user.user);
    const { vault: target } = await createVaultWithOwner(user.user);
    const item = await createItem(source, user.user);
    const newWrapped = wrapped();
    const res = await user.client.post(`/api/items/${item.id}/move`, {
      targetVaultId: target.id,
      wrappedKey: newWrapped,
      vaultKeyVersion: target.keyVersion,
      revision: item.revision,
    });
    expect(res.status).toBe(200);
    const { item: moved } = parseWith(moveItemResponseSchema, await body(res));
    expect(moved).toMatchObject({
      id: item.id,
      vaultId: target.id,
      wrappedKey: newWrapped,
      vaultKeyVersion: target.keyVersion,
      revision: item.revision + 1,
      encryptedData: item.encryptedData,
      itemKeyVersion: item.itemKeyVersion,
    });
    const tombstones = await db.select().from(deletions);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      entity: "item",
      entityId: item.id,
      vaultId: source.id,
      userId: null,
    });
  });

  it("keeps item shares on the moved item", async () => {
    const user = await signedInClient();
    const recipient = await createUser();
    const { vault: source } = await createVaultWithOwner(user.user);
    const { vault: target } = await createVaultWithOwner(user.user);
    const item = await createItem(source, user.user);
    const now = Date.now();
    await db.insert(itemShares).values({
      id: uuid(),
      itemId: item.id,
      userId: recipient.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed(),
      status: "active",
      invitedBy: user.user.id,
      createdAt: now,
      updatedAt: now,
    });
    const res = await user.client.post(`/api/items/${item.id}/move`, {
      targetVaultId: target.id,
      wrappedKey: wrapped(),
      vaultKeyVersion: 1,
      revision: 1,
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(itemShares)).toHaveLength(1);
  });

  it("needs editor+ in both vaults and a fresh revision / target key version", async () => {
    const t = await vaultWithRoles();
    const other = await signedInClient();
    const { vault: otherVault } = await createVaultWithOwner(other.user);
    const item = await createItem(t.vault, t.owner.user);
    const move = (client: typeof t.editor.client, extra: object = {}) =>
      client.post(`/api/items/${item.id}/move`, {
        targetVaultId: otherVault.id,
        wrappedKey: wrapped(),
        vaultKeyVersion: 1,
        revision: 1,
        ...extra,
      });

    // The editor is not a member of the target vault.
    expect((await move(t.editor.client)).status).toBe(404);
    const targetMember = await addMember(otherVault, t.editor.user, "viewer");
    expect((await move(t.editor.client)).status).toBe(403);
    expect((await move(t.viewer.client)).status).toBe(403);
    expect((await move(t.outsider.client)).status).toBe(404);
    await db
      .update(vaultMembers)
      .set({ role: "editor" })
      .where(eq(vaultMembers.id, targetMember.id));

    const staleKey = await move(t.editor.client, { vaultKeyVersion: 4 });
    expect(staleKey.status).toBe(409);
    expect(await errorCode(staleKey)).toBe("key_version_mismatch");
    const staleRev = await move(t.editor.client, { revision: 9 });
    expect(staleRev.status).toBe(409);
    expect(await errorCode(staleRev)).toBe("revision_conflict");
    const same = await t.editor.client.post(`/api/items/${item.id}/move`, {
      targetVaultId: t.vault.id,
      wrappedKey: wrapped(),
      vaultKeyVersion: 1,
      revision: 1,
    });
    expect(same.status).toBe(400);
    expect((await move(t.editor.client)).status).toBe(200);
  });
});

describe("item share editors", () => {
  beforeEach(resetDb);

  async function shared(role: "viewer" | "editor") {
    const owner = await signedInClient();
    const recipient = await signedInClient();
    const { vault } = await createVaultWithOwner(owner.user);
    const item = await createItem(vault, owner.user);
    const now = Date.now();
    await db.insert(itemShares).values({
      id: uuid(),
      itemId: item.id,
      userId: recipient.user.id,
      role,
      keyVersion: 1,
      sealedKey: sealed(),
      status: "active",
      invitedBy: owner.user.id,
      createdAt: now,
      updatedAt: now,
    });
    return { owner, recipient, vault, item };
  }

  it("an editor recipient updates the content with unchanged keys", async () => {
    const { recipient, item } = await shared("editor");
    const res = await recipient.client.put(`/api/items/${item.id}`, updateItemBody(item));
    expect(res.status).toBe(200);
    const { item: updated } = parseWith(updateItemResponseSchema, await body(res));
    expect(updated).toMatchObject({
      revision: 2,
      updatedBy: recipient.user.id,
      wrappedKey: item.wrappedKey,
    });
  });

  it("cannot change the key fields, rotate keys, trash, move or delete", async () => {
    const { recipient, item } = await shared("editor");
    const changed = await recipient.client.put(
      `/api/items/${item.id}`,
      updateItemBody(item, { wrappedKey: wrapped() }),
    );
    expect(changed.status).toBe(409);
    expect(await errorCode(changed)).toBe("key_version_mismatch");
    const withKeys = await recipient.client.put(
      `/api/items/${item.id}`,
      updateItemBody(item, { shareKeys: [{ shareId: uuid(), sealedKey: sealed() }] }),
    );
    expect(withKeys.status).toBe(403);
    expect((await recipient.client.post(`/api/items/${item.id}/trash`, {})).status).toBe(403);
    expect((await recipient.client.delete(`/api/items/${item.id}`)).status).toBe(403);
  });

  it("a viewer recipient cannot write", async () => {
    const { recipient, item } = await shared("viewer");
    expect((await recipient.client.put(`/api/items/${item.id}`, updateItemBody(item))).status).toBe(
      403,
    );
  });

  it("a pending recipient has no access yet", async () => {
    const owner = await signedInClient();
    const recipient = await signedInClient();
    const { vault } = await createVaultWithOwner(owner.user);
    const item = await createItem(vault, owner.user);
    const now = Date.now();
    await db.insert(itemShares).values({
      id: uuid(),
      itemId: item.id,
      userId: recipient.user.id,
      role: "editor",
      keyVersion: 1,
      sealedKey: sealed(),
      status: "pending",
      invitedBy: owner.user.id,
      createdAt: now,
      updatedAt: now,
    });
    expect((await recipient.client.put(`/api/items/${item.id}`, updateItemBody(item))).status).toBe(
      404,
    );
  });
});
