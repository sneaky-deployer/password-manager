import { rotateVaultResponseSchema, syncResponseSchema } from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Item,
  itemShares,
  items,
  vaultMembers,
  vaultRotationItems,
  vaults,
} from "../src/db/schema.ts";
import { createItem, createUser, db, resetDb, signedInClient } from "./helpers.ts";
import {
  addMember,
  backdateAll,
  body,
  createItemBody,
  envelope,
  parseWith,
  sealed,
  uuid,
  vaultWithRoles,
  wrapped,
} from "./vault-helpers.ts";

type ErrorBody = { error: { code: string; details?: Record<string, unknown> } };

const rotatePath = (vaultId: string) => `/api/vaults/${vaultId}/rotate`;

function chunkBody(vaultItems: Item[], newKeyVersion = 2, overrides: object = {}) {
  return {
    step: "chunk" as const,
    newKeyVersion,
    items: vaultItems.map((item) => ({
      id: item.id,
      revision: item.revision,
      itemKeyVersion: item.itemKeyVersion + 1,
      wrappedKey: wrapped(),
      vaultKeyVersion: newKeyVersion,
      encryptedData: envelope(),
      ...overrides,
    })),
  };
}

async function errorOf(res: Response) {
  return (await body<ErrorBody>(res)).error;
}

/** Everything a rotation touches, read straight from the database. */
async function snapshot(vaultId: string) {
  const [vault] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
  return {
    vault,
    members: await db.select().from(vaultMembers).where(eq(vaultMembers.vaultId, vaultId)),
    items: await db.select().from(items).where(eq(items.vaultId, vaultId)),
    shares: await db.select().from(itemShares),
    staged: await db.select().from(vaultRotationItems),
  };
}

/** A vault after `viewer` was removed: owner, manager, editor, a pending invitee, 3 items, 1 share. */
async function removedViewerSetup() {
  const t = await vaultWithRoles();
  const pending = await createUser();
  const pendingMember = await addMember(t.vault, pending, "viewer", { status: "pending" });
  const a = await createItem(t.vault, t.owner.user);
  const b = await createItem(t.vault, t.editor.user);
  const trashed = await createItem(t.vault, t.owner.user, { trashedAt: Date.now() });
  const recipient = await signedInClient();
  const now = Date.now();
  const [share] = await db
    .insert(itemShares)
    .values({
      id: uuid(),
      itemId: a.id,
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

  const removal = await t.manager.client.delete(
    `/api/vaults/${t.vault.id}/members/${t.viewer.member.id}`,
  );
  expect(removal.status).toBe(200);

  const vaultItems = [a, b, trashed];
  const remaining = [t.owner.member, t.manager.member, t.editor.member, pendingMember];
  const finalizeBody = (overrides: object = {}) => ({
    step: "finalize" as const,
    newKeyVersion: 2,
    encryptedMeta: envelope(60),
    memberKeys: remaining.map((member) => ({ memberId: member.id, sealedKey: sealed() })),
    itemShareKeys: [{ shareId: share.id, sealedKey: sealed() }],
    ...overrides,
  });
  return { t, vaultItems, remaining, share, recipient, pendingMember, finalizeBody };
}

describe("rotation: happy path", () => {
  beforeEach(resetDb);

  it("remove member -> rotation_pending -> chunks -> finalize swaps everything at once", async () => {
    const { t, vaultItems, remaining, share, finalizeBody } = await removedViewerSetup();
    const before = await snapshot(t.vault.id);
    expect(before.vault?.rotationPending).toBe(true);
    expect(before.vault?.keyVersion).toBe(1);

    // Two chunks (2 + 1 items), and one of them sent twice: staging is idempotent.
    const first = chunkBody(vaultItems.slice(0, 2));
    const second = chunkBody(vaultItems.slice(2));
    const r1 = await t.manager.client.post(rotatePath(t.vault.id), first);
    expect(r1.status).toBe(200);
    expect(parseWith(rotateVaultResponseSchema, await body(r1))).toEqual({
      step: "chunk",
      accepted: 2,
    });
    const resend = chunkBody(vaultItems.slice(0, 2));
    expect((await t.manager.client.post(rotatePath(t.vault.id), resend)).status).toBe(200);
    expect((await t.manager.client.post(rotatePath(t.vault.id), second)).status).toBe(200);

    // Staging has not touched live data: others keep working with the old key.
    const staged = await snapshot(t.vault.id);
    expect(staged.staged).toHaveLength(3);
    expect(
      staged.items.map((i) => [i.id, i.revision, i.vaultKeyVersion, i.wrappedKey]).sort(),
    ).toEqual(before.items.map((i) => [i.id, i.revision, i.vaultKeyVersion, i.wrappedKey]).sort());
    expect(staged.vault?.keyVersion).toBe(1);

    const sentMeta = envelope(60);
    const fin = finalizeBody({ encryptedMeta: sentMeta });
    const res = await t.manager.client.post(rotatePath(t.vault.id), fin);
    expect(res.status).toBe(200);
    const parsed = parseWith(rotateVaultResponseSchema, await body(res));
    if (parsed.step !== "finalize") throw new Error("expected finalize");
    expect(parsed.vault).toMatchObject({
      id: t.vault.id,
      keyVersion: 2,
      rotationPending: false,
      encryptedMeta: sentMeta,
      myRole: "manager",
    });

    const after = await snapshot(t.vault.id);
    expect(after.staged).toEqual([]);
    expect(after.vault).toMatchObject({
      keyVersion: 2,
      rotationPending: false,
      encryptedMeta: sentMeta,
    });
    const stagedSecond = resend.items; // the resend replaced the first upload
    const expected = new Map([...stagedSecond, ...second.items].map((entry) => [entry.id, entry]));
    for (const item of after.items) {
      const entry = expected.get(item.id);
      const old = before.items.find((i) => i.id === item.id);
      expect(item).toMatchObject({
        vaultKeyVersion: 2,
        itemKeyVersion: 2,
        wrappedKey: entry?.wrappedKey,
        encryptedData: entry?.encryptedData,
        revision: (old?.revision ?? 0) + 1,
      });
      expect(item.updatedAt).toBeGreaterThan(old?.updatedAt ?? Number.MAX_SAFE_INTEGER);
      // Not an edit: authorship and trash state are untouched.
      expect(item.updatedBy).toBe(old?.updatedBy);
      expect(item.trashedAt).toBe(old?.trashedAt);
    }
    for (const member of after.members) {
      const sent = fin.memberKeys.find((entry) => entry.memberId === member.id);
      if (remaining.some((m) => m.id === member.id)) {
        expect(member).toMatchObject({ keyVersion: 2, sealedKey: sent?.sealedKey });
      }
    }
    expect(after.members.map((m) => m.id).sort()).toEqual(remaining.map((m) => m.id).sort());
    expect(after.shares[0]).toMatchObject({
      id: share.id,
      keyVersion: 2,
      sealedKey: fin.itemShareKeys[0]?.sealedKey,
    });
  });

  it("afterwards writes need the new key version, and a second finalize is refused", async () => {
    const { t, vaultItems, finalizeBody } = await removedViewerSetup();
    await t.manager.client.post(rotatePath(t.vault.id), chunkBody(vaultItems));
    expect((await t.manager.client.post(rotatePath(t.vault.id), finalizeBody())).status).toBe(200);

    const old = await t.editor.client.post("/api/items", createItemBody(t.vault.id, 1));
    expect(old.status).toBe(409);
    expect((await errorOf(old)).code).toBe("key_version_mismatch");
    const fresh = await t.editor.client.post("/api/items", createItemBody(t.vault.id, 2));
    expect(fresh.status).toBe(201);

    const again = await t.manager.client.post(rotatePath(t.vault.id), finalizeBody());
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("key_version_mismatch");

    // The removed member is out for good.
    expect(
      (await t.viewer.client.post(rotatePath(t.vault.id), chunkBody(vaultItems, 3))).status,
    ).toBe(404);
  });

  it("new invites and item shares work again after the rotation", async () => {
    const { t, vaultItems, finalizeBody } = await removedViewerSetup();
    const guest = await createUser();
    const blocked = await t.owner.client.post(`/api/vaults/${t.vault.id}/members`, {
      userId: guest.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed(),
    });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).code).toBe("rotation_pending");

    await t.owner.client.post(rotatePath(t.vault.id), chunkBody(vaultItems));
    await t.owner.client.post(rotatePath(t.vault.id), finalizeBody());
    const ok = await t.owner.client.post(`/api/vaults/${t.vault.id}/members`, {
      userId: guest.id,
      role: "viewer",
      keyVersion: 2,
      sealedKey: sealed(),
    });
    expect(ok.status).toBe(201);
  });

  it("item writes are blocked while pending, trash / restore / delete are not", async () => {
    const { t, vaultItems } = await removedViewerSetup();
    const [item] = vaultItems;
    if (!item) throw new Error("no item");
    const put = await t.editor.client.put(`/api/items/${item.id}`, {
      itemKeyVersion: 1,
      wrappedKey: item.wrappedKey,
      vaultKeyVersion: 1,
      encryptedData: envelope(),
      revision: 1,
    });
    expect(put.status).toBe(409);
    expect((await errorOf(put)).code).toBe("rotation_pending");
    expect((await t.editor.client.post("/api/items", createItemBody(t.vault.id))).status).toBe(409);
    expect((await t.editor.client.post(`/api/items/${item.id}/trash`, {})).status).toBe(200);
    expect((await t.editor.client.post(`/api/items/${item.id}/restore`, {})).status).toBe(200);
  });

  it("a trashed item that is permanently deleted mid-rotation no longer blocks the finalize", async () => {
    const { t, vaultItems, finalizeBody } = await removedViewerSetup();
    const trashed = vaultItems[2];
    if (!trashed) throw new Error("no item");
    await t.owner.client.post(rotatePath(t.vault.id), chunkBody(vaultItems));
    expect((await t.editor.client.delete(`/api/items/${trashed.id}`)).status).toBe(200);
    expect((await snapshot(t.vault.id)).staged).toHaveLength(2); // cascade removed its staged row
    expect((await t.owner.client.post(rotatePath(t.vault.id), finalizeBody())).status).toBe(200);
  });

  it("members get the new keys through incremental sync", async () => {
    const { t, vaultItems, finalizeBody } = await removedViewerSetup();
    await backdateAll(Date.now() - 60 * 60 * 1000);
    const since = Date.now() - 30 * 60 * 1000;
    // backdateAll also aged the vault flag; finalize now.
    await t.owner.client.post(rotatePath(t.vault.id), chunkBody(vaultItems));
    const fin = finalizeBody();
    await t.owner.client.post(rotatePath(t.vault.id), fin);

    const res = await t.editor.client.get(`/api/sync?since=${since}`);
    const sync = parseWith(syncResponseSchema, await body(res));
    expect(sync.vaults[0]).toMatchObject({ keyVersion: 2, rotationPending: false });
    expect(sync.items).toHaveLength(3);
    expect(sync.items.every((item) => item.vaultKeyVersion === 2)).toBe(true);
    const mine = sync.members.find((m) => m.userId === t.editor.user.id);
    expect(mine).toMatchObject({
      keyVersion: 2,
      sealedKey: fin.memberKeys.find((k) => k.memberId === t.editor.member.id)?.sealedKey,
    });
  });
});

describe("rotation: finalize refusals leave everything untouched", () => {
  beforeEach(resetDb);

  async function expectUntouched(
    setup: Awaited<ReturnType<typeof removedViewerSetup>>,
    stagedCount: number,
  ) {
    const state = await snapshot(setup.t.vault.id);
    expect(state.vault).toMatchObject({ keyVersion: 1, rotationPending: true });
    expect(
      state.items.every((item) => item.vaultKeyVersion === 1 && item.itemKeyVersion === 1),
    ).toBe(true);
    expect(state.members.every((member) => member.keyVersion === 1)).toBe(true);
    expect(state.shares.every((share) => share.keyVersion === 1)).toBe(true);
    expect(state.staged).toHaveLength(stagedCount);
  }

  it("rejects a finalize without any staged items", async () => {
    const s = await removedViewerSetup();
    const res = await s.t.owner.client.post(rotatePath(s.t.vault.id), s.finalizeBody());
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("conflict");
    expect(((error.details?.missingItemIds ?? []) as string[]).sort()).toEqual(
      s.vaultItems.map((i) => i.id).sort(),
    );
    await expectUntouched(s, 0);
  });

  it("rejects a finalize with a missing item (the trashed one counts too)", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems.slice(0, 2)));
    const res = await s.t.owner.client.post(rotatePath(s.t.vault.id), s.finalizeBody());
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("conflict");
    expect(error.details?.missingItemIds).toEqual([s.vaultItems[2]?.id]);
    await expectUntouched(s, 2);
  });

  it("rejects a finalize when an item changed after it was staged", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const moved = s.vaultItems[0];
    if (!moved) throw new Error("no item");
    await db.update(items).set({ revision: 2 }).where(eq(items.id, moved.id));
    const res = await s.t.owner.client.post(rotatePath(s.t.vault.id), s.finalizeBody());
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("revision_conflict");
    expect(error.details).toMatchObject({ currentRevision: 2, staleItemIds: [moved.id] });
    const state = await snapshot(s.t.vault.id);
    expect(state.vault?.keyVersion).toBe(1);
    expect(state.items.every((item) => item.vaultKeyVersion === 1)).toBe(true);
  });

  it("rejects a finalize missing a member key (pending members count)", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const withoutPending = s.remaining
      .filter((member) => member.id !== s.pendingMember.id)
      .map((member) => ({ memberId: member.id, sealedKey: sealed() }));
    const res = await s.t.owner.client.post(
      rotatePath(s.t.vault.id),
      s.finalizeBody({ memberKeys: withoutPending }),
    );
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("conflict");
    expect(error.details?.missingMemberIds).toEqual([s.pendingMember.id]);
    await expectUntouched(s, 3);
  });

  it("rejects a finalize that still contains the removed member or unknown ids", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const keys = s.remaining.map((member) => ({ memberId: member.id, sealedKey: sealed() }));
    for (const extra of [t_removedId(s), uuid()]) {
      const res = await s.t.owner.client.post(
        rotatePath(s.t.vault.id),
        s.finalizeBody({ memberKeys: [...keys, { memberId: extra, sealedKey: sealed() }] }),
      );
      expect(res.status).toBe(400);
    }
    const dup = await s.t.owner.client.post(
      rotatePath(s.t.vault.id),
      s.finalizeBody({ memberKeys: [...keys, ...keys.slice(0, 1)] }),
    );
    expect(dup.status).toBe(400);
    await expectUntouched(s, 3);
  });

  it("rejects a finalize missing an item share key, or with unknown ones", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const missing = await s.t.owner.client.post(
      rotatePath(s.t.vault.id),
      s.finalizeBody({ itemShareKeys: [] }),
    );
    expect(missing.status).toBe(409);
    expect((await errorOf(missing)).details?.missingShareIds).toEqual([s.share.id]);
    const unknown = await s.t.owner.client.post(
      rotatePath(s.t.vault.id),
      s.finalizeBody({
        itemShareKeys: [
          { shareId: s.share.id, sealedKey: sealed() },
          { shareId: uuid(), sealedKey: sealed() },
        ],
      }),
    );
    expect(unknown.status).toBe(400);
    await expectUntouched(s, 3);
  });

  it("rejects the wrong newKeyVersion", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    for (const version of [1, 3]) {
      const res = await s.t.owner.client.post(
        rotatePath(s.t.vault.id),
        s.finalizeBody({ newKeyVersion: version }),
      );
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe("key_version_mismatch");
    }
    await expectUntouched(s, 3);
  });

  it("only owner and manager may rotate", async () => {
    const s = await removedViewerSetup();
    for (const actor of [s.t.editor]) {
      expect(
        (await actor.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems))).status,
      ).toBe(403);
      expect((await actor.client.post(rotatePath(s.t.vault.id), s.finalizeBody())).status).toBe(
        403,
      );
    }
    expect(
      (await s.t.outsider.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems))).status,
    ).toBe(404);
    expect(
      (await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems))).status,
    ).toBe(200);
  });
});

function t_removedId(s: Awaited<ReturnType<typeof removedViewerSetup>>): string {
  return s.t.viewer.member.id;
}

describe("rotation: chunk validation", () => {
  beforeEach(resetDb);

  it("rejects wrong new key versions, items of other vaults, unknown ids and duplicates", async () => {
    const s = await removedViewerSetup();
    const { t, vaultItems } = s;
    const other = await signedInClient();
    const { createVaultWithOwner } = await import("./helpers.ts");
    const { vault: foreign } = await createVaultWithOwner(other.user);
    const foreignItem = await createItem(foreign, other.user);

    const wrongVersion = await t.owner.client.post(
      rotatePath(t.vault.id),
      chunkBody(vaultItems, 3),
    );
    expect(wrongVersion.status).toBe(409);
    expect((await errorOf(wrongVersion)).code).toBe("key_version_mismatch");

    const foreignRes = await t.owner.client.post(rotatePath(t.vault.id), chunkBody([foreignItem]));
    expect(foreignRes.status).toBe(409);
    expect((await errorOf(foreignRes)).details?.unknownItemIds).toEqual([foreignItem.id]);

    const ghost = chunkBody(vaultItems.slice(0, 1));
    ghost.items[0] = { ...ghost.items[0], id: uuid() } as (typeof ghost.items)[number];
    expect((await t.owner.client.post(rotatePath(t.vault.id), ghost)).status).toBe(409);

    const dup = chunkBody(vaultItems.slice(0, 1));
    dup.items.push(dup.items[0] as (typeof dup.items)[number]);
    expect((await t.owner.client.post(rotatePath(t.vault.id), dup)).status).toBe(400);

    const wrongItemVault = await t.owner.client.post(
      rotatePath(t.vault.id),
      chunkBody(vaultItems, 2, { vaultKeyVersion: 1 }),
    );
    expect(wrongItemVault.status).toBe(409);
    expect((await errorOf(wrongItemVault)).code).toBe("key_version_mismatch");

    const sameKey = await t.owner.client.post(
      rotatePath(t.vault.id),
      chunkBody(vaultItems, 2, { itemKeyVersion: 1 }),
    );
    expect(sameKey.status).toBe(400);

    const stale = chunkBody(vaultItems.slice(0, 1));
    (stale.items[0] as { revision: number }).revision = 5;
    const staleRes = await t.owner.client.post(rotatePath(t.vault.id), stale);
    expect(staleRes.status).toBe(409);
    expect((await errorOf(staleRes)).code).toBe("revision_conflict");
    expect((await snapshot(t.vault.id)).staged).toEqual([]);

    expect(
      (
        await t.owner.client.post(rotatePath(t.vault.id), {
          step: "chunk",
          newKeyVersion: 2,
          items: [],
        })
      ).status,
    ).toBe(400);
  });
});

describe("rotation: larger vaults (statement chunking)", () => {
  beforeEach(resetDb);

  it("handles a 100 item chunk plus 60 members and 60 item shares in one finalize", async () => {
    const t = await vaultWithRoles();
    const created: Item[] = [];
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      created.push(
        await createItem(t.vault, t.owner.user, { createdAt: now - 1000, updatedAt: now - 1000 }),
      );
    }
    const memberUsers = await Promise.all(Array.from({ length: 56 }, () => createUser()));
    const extraMembers = [];
    for (const user of memberUsers) extraMembers.push(await addMember(t.vault, user, "viewer"));
    const shareRows = [];
    for (let i = 0; i < 60; i++) {
      const recipient = await createUser();
      const [row] = await db
        .insert(itemShares)
        .values({
          id: uuid(),
          itemId: (created[i] as Item).id,
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
      if (row) shareRows.push(row);
    }
    // A voluntary rotation: nothing pending, no member removed.
    const chunk = await t.owner.client.post(rotatePath(t.vault.id), chunkBody(created));
    expect(chunk.status).toBe(200);
    expect(parseWith(rotateVaultResponseSchema, await body(chunk))).toEqual({
      step: "chunk",
      accepted: 100,
    });

    const allMembers = [
      t.owner.member,
      t.manager.member,
      t.editor.member,
      t.viewer.member,
      ...extraMembers,
    ];
    const res = await t.owner.client.post(rotatePath(t.vault.id), {
      step: "finalize",
      newKeyVersion: 2,
      encryptedMeta: envelope(60),
      memberKeys: allMembers.map((member) => ({ memberId: member.id, sealedKey: sealed() })),
      itemShareKeys: shareRows.map((share) => ({ shareId: share.id, sealedKey: sealed() })),
    });
    expect(res.status).toBe(200);

    const state = await snapshot(t.vault.id);
    expect(state.vault).toMatchObject({ keyVersion: 2, rotationPending: false });
    expect(state.items).toHaveLength(100);
    expect(state.items.every((item) => item.vaultKeyVersion === 2 && item.revision === 2)).toBe(
      true,
    );
    expect(state.members).toHaveLength(60);
    expect(state.members.every((member) => member.keyVersion === 2)).toBe(true);
    expect(state.shares).toHaveLength(60);
    expect(state.shares.every((share) => share.keyVersion === 2)).toBe(true);
    expect(state.staged).toEqual([]);
  }, 60_000);
});

describe("rotation: the SQL guard in the finalize batch", () => {
  beforeEach(resetDb);

  /** A db whose atomic write batch is preceded by `race()`: a change landing between check and write. */
  function racingDb(race: () => Promise<void>) {
    return new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "batch") {
          return async (statements: unknown[]) => {
            if (statements.length > 3) await race(); // the reads are 3 statements, the write more
            return (target.batch as (s: unknown[]) => Promise<unknown>)(statements);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("an item edited between the checks and the batch aborts the whole finalize", async () => {
    const { finalizeRotation } = await import("../src/lib/vaults/rotation.ts");
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const [vault] = await db.select().from(vaults).where(eq(vaults.id, s.t.vault.id));
    if (!vault) throw new Error("no vault");
    const victim = s.vaultItems[1];
    if (!victim) throw new Error("no item");

    const promise = finalizeRotation(
      racingDb(async () => {
        await db.update(items).set({ revision: 9 }).where(eq(items.id, victim.id));
      }) as unknown as typeof db,
      vault,
      s.finalizeBody() as Parameters<typeof finalizeRotation>[2],
      s.t.owner.user.id,
      Date.now(),
    );
    await expect(promise).rejects.toMatchObject({ code: "conflict", status: 409 });

    const state = await snapshot(s.t.vault.id);
    expect(state.vault).toMatchObject({ keyVersion: 1, rotationPending: true });
    expect(
      state.items.every((item) => item.vaultKeyVersion === 1 && item.itemKeyVersion === 1),
    ).toBe(true);
    expect(state.members.every((member) => member.keyVersion === 1)).toBe(true);
    expect(state.shares.every((share) => share.keyVersion === 1)).toBe(true);
    expect(state.staged).toHaveLength(3);
  });

  it("a member added between the checks and the batch aborts the whole finalize", async () => {
    const { finalizeRotation } = await import("../src/lib/vaults/rotation.ts");
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const [vault] = await db.select().from(vaults).where(eq(vaults.id, s.t.vault.id));
    if (!vault) throw new Error("no vault");
    const latecomer = await createUser();

    const promise = finalizeRotation(
      racingDb(async () => {
        await addMember(vault, latecomer, "viewer", { status: "pending" });
      }) as unknown as typeof db,
      vault,
      s.finalizeBody() as Parameters<typeof finalizeRotation>[2],
      s.t.owner.user.id,
      Date.now(),
    );
    await expect(promise).rejects.toMatchObject({ code: "conflict", status: 409 });
    const state = await snapshot(s.t.vault.id);
    expect(state.vault?.keyVersion).toBe(1);
    expect(state.members.every((member) => member.keyVersion === 1)).toBe(true);
  });

  it("two finalizes in a row cannot apply twice", async () => {
    const s = await removedViewerSetup();
    await s.t.owner.client.post(rotatePath(s.t.vault.id), chunkBody(s.vaultItems));
    const fin = s.finalizeBody();
    const results = await Promise.all([
      s.t.owner.client.post(rotatePath(s.t.vault.id), fin),
      s.t.manager.client.post(rotatePath(s.t.vault.id), fin),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const state = await snapshot(s.t.vault.id);
    expect(state.vault?.keyVersion).toBe(2);
    expect(state.items.every((item) => item.revision === 2 && item.vaultKeyVersion === 2)).toBe(
      true,
    );
  });
});
