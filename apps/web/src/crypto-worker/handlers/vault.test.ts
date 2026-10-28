// @vitest-environment node
import { encryptItem, generateKey, openSealedKey, sealKey, wrapItemKey } from "@pm/crypto";
import type { ItemContent, ItemWire, KeyBundle, PendingShare, VaultRole } from "@pm/shared";
import { MAX_ROTATION_CHUNK_ITEMS } from "@pm/shared";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "../dispatch.ts";
import type { OpArgs, OpName, OpResult } from "../protocol.ts";
import { createHandlers } from "../registry.ts";
import { createWorkerState } from "../state.ts";
import { FakeServer } from "../vault/fake-server.ts";

const FAST_KDF = { alg: "argon2id13", mem: 16 * 1024 * 1024, ops: 2 } as const;
const PASSWORD = "correct horse battery staple";

/** One simulated browser: its own worker state, handlers and dispatcher. */
async function newUser(name: string, server?: FakeServer) {
  const state = createWorkerState();
  const dispatch = createDispatcher(createHandlers(state, { kdf: FAST_KDF }));
  let nextId = 0;
  async function call<K extends OpName>(op: K, args?: OpArgs<K>): Promise<OpResult<K>> {
    const response = await dispatch({ id: ++nextId, op, args });
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    return response.result as OpResult<K>;
  }
  async function errorOf(op: OpName, args?: unknown) {
    const response = await dispatch({ id: ++nextId, op, args });
    if (response.ok) throw new Error(`expected ${op} to fail`);
    return response.error;
  }
  const { creation } = await call("createAccount", {
    password: PASSWORD,
    vaultName: `${name} vault`,
  });
  await call("commitAccountCreation");
  const user = {
    name,
    state,
    call,
    errorOf,
    id: creation.user.id,
    email: `${name}@example.com`,
    publicKey: creation.user.publicKey,
    creation,
    bundle: {
      userId: creation.user.id,
      kdf: creation.user.kdf,
      salt: creation.user.salt,
      wrappedAkPw: creation.user.wrappedAkPw,
      publicKey: creation.user.publicKey,
      encryptedPrivateKey: creation.user.encryptedPrivateKey,
      keyGeneration: 1,
    } satisfies KeyBundle,
  };
  if (server) {
    server.addUser(user.id, user.email, user.publicKey);
    server.createVault(user.id, creation.vault);
  }
  return user;
}
type User = Awaited<ReturnType<typeof newUser>>;

const login = (name: string, extra: Partial<Extract<ItemContent, { type: "login" }>> = {}) =>
  ({
    type: "login",
    name,
    username: `${name}@mail.test`,
    password: `pw-${name}`,
    urls: [`https://${name}.test`],
    customFields: [],
    ...extra,
  }) satisfies ItemContent;

async function addItem(server: FakeServer, user: User, vaultId: string, content: ItemContent) {
  // The UI always syncs before it writes, so the vault and its key are known.
  await user.call("applySync", { response: server.sync(user.id) });
  const { body } = await user.call("createItem", { vaultId, content });
  return server.createItem(user.id, body);
}

async function sync(server: FakeServer, user: User, extra = {}) {
  return user.call("applySync", { response: server.sync(user.id, extra) });
}

/** Invite `member` to `vaultId` the way the UI does and let them accept. */
async function shareVault(
  server: FakeServer,
  owner: User,
  member: User,
  vaultId: string,
  role: VaultRole = "editor",
) {
  await owner.call("applySync", { response: server.sync(owner.id) });
  const sealed = await owner.call("sealVaultKeyFor", { vaultId, publicKey: member.publicKey });
  return server.addMember(vaultId, member.id, role, sealed.sealedKey, sealed.keyVersion);
}

describe("vault worker: sync and views", () => {
  it("lists vaults and items with list-safe fields only", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const vaultId = alice.creation.vault.id;
    await addItem(
      server,
      alice,
      vaultId,
      login("github", { totp: "otpauth://totp/x?secret=AAAA" }),
    );
    await addItem(server, alice, vaultId, { type: "note", name: "Wifi", notes: "hunter2 secret" });

    const snapshot = await sync(server, alice);
    expect(snapshot.vaults).toHaveLength(1);
    expect(snapshot.vaults[0]).toMatchObject({
      id: vaultId,
      name: "alice vault",
      myRole: "owner",
      isOwner: true,
      memberCount: 1,
      rotationPending: false,
      readable: true,
    });
    const github = snapshot.items.find((item) => item.name === "github");
    expect(github).toMatchObject({
      type: "login",
      username: "github@mail.test",
      urls: ["https://github.test"],
      hasTotp: true,
      hasPassword: true,
      trashed: false,
      sharedWithMe: false,
      readable: true,
      canEdit: true,
      canManage: true,
      canShare: true,
    });
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("pw-github");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret=AAAA");
  });

  it("getItem returns the full content on demand", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("bank"));
    await sync(server, alice);
    const detail = await alice.call("getItem", { id: item.id });
    expect(detail.content).toMatchObject({ type: "login", name: "bank", password: "pw-bank" });
    expect(detail.content?.type === "login" && detail.content.passwordUpdatedAt).toBeGreaterThan(0);
    expect(detail.item.id).toBe(item.id);
  });

  it("is idempotent when the server re-sends the overlap", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    await addItem(server, alice, alice.creation.vault.id, login("one"));
    const first = await sync(server, alice, { full: false });
    const second = await sync(server, alice, { full: false });
    expect(second).toEqual(first);
    expect(second.items).toHaveLength(1);
  });

  it("applies deletions before upserts (an item moved A -> B -> A stays)", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("moved"));
    await sync(server, alice);
    const again = await sync(server, alice, {
      full: false,
      deletions: [{ entity: "item", id: item.id, deletedAt: 1 }],
    });
    expect(again.items.map((i) => i.id)).toEqual([item.id]);

    const gone = await alice.call("applySync", {
      response: {
        ...server.sync(alice.id),
        full: false,
        items: [],
        deletions: [{ entity: "item", id: item.id, deletedAt: 2 }],
      },
    });
    expect(gone.items).toHaveLength(0);
  });

  it("never replaces a newer row with an older re-sent one", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const vaultId = alice.creation.vault.id;
    const item = await addItem(server, alice, vaultId, login("old"));
    await sync(server, alice);
    await sync(server, alice);
    const stale = server.items.get(item.id) as ItemWire;
    const { body } = await alice.call("updateItem", {
      id: item.id,
      content: login("new"),
      revision: 1,
    });
    server.updateItem(alice.id, item.id, body);
    const fresh = await sync(server, alice);
    expect(fresh.items[0]?.name).toBe("new");
    const replay = await alice.call("applySync", {
      response: { ...server.sync(alice.id), full: false, items: [stale] },
    });
    expect(replay.items[0]?.name).toBe("new");
    expect(replay.items[0]?.revision).toBe(2);
  });

  it("keeps trashed items (flagged) and a full sync drops what the snapshot lacks", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("trash me"));
    server.trashItem(item.id, true);
    const snapshot = await sync(server, alice);
    expect(snapshot.items[0]).toMatchObject({ trashed: true });
    const empty = await alice.call("applySync", {
      response: { ...server.sync(alice.id), items: [] },
    });
    expect(empty.items).toHaveLength(0);
  });

  it("shows a record that cannot be decrypted as unreadable without failing the sync", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const vaultId = alice.creation.vault.id;
    await addItem(server, alice, vaultId, login("fine"));

    const broken = await addItem(server, alice, vaultId, login("broken"));
    server.items.set(broken.id, {
      ...broken,
      encryptedData: `${broken.encryptedData.slice(0, -4)}AAAA`,
    });

    // Valid ciphertext, but the content does not match the item schema.
    const vk = alice.state.vaultKeys.get(vaultId)?.get(1) as Uint8Array;
    const ik = await generateKey();
    const badId = crypto.randomUUID();
    const wrongShape = await encryptItem(ik, badId, 1, { type: "login", name: "", surprise: true });
    server.items.set(badId, {
      ...broken,
      id: badId,
      wrappedKey: await wrapItemKey(vk, vaultId, badId, 1, ik),
      encryptedData: wrongShape,
    });

    const snapshot = await sync(server, alice);
    expect(snapshot.items).toHaveLength(3);
    const unreadable = snapshot.items.filter((item) => !item.readable);
    expect(unreadable).toHaveLength(2);
    for (const item of unreadable) {
      expect(item).toMatchObject({ name: "Unreadable item", type: "unknown", urls: [] });
    }
    const detail = await alice.call("getItem", { id: broken.id });
    expect(detail.content).toBeNull();
  });

  it("marks a vault whose key does not open as unreadable", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const vaultId = alice.creation.vault.id;
    // Bob receives a key sealed for the wrong key version.
    const vk = alice.state.vaultKeys.get(vaultId)?.get(1) as Uint8Array;
    const wrong = await sealKey(bob.publicKey, {
      type: "vault",
      id: vaultId,
      keyVersion: 7,
      key: vk,
    });
    server.addMember(vaultId, bob.id, "editor", wrong, 1);
    await addItem(server, alice, vaultId, login("secret"));
    const snapshot = await sync(server, bob);
    const vault = snapshot.vaults.find((v) => v.id === vaultId);
    expect(vault).toMatchObject({ name: "Unreadable vault", readable: false });
    expect(snapshot.items[0]).toMatchObject({ readable: false, name: "Unreadable item" });
  });
});

describe("vault worker: writes", () => {
  it("builds a create body that decrypts for the owner and rejects a viewer", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const vaultId = alice.creation.vault.id;
    await shareVault(server, alice, bob, vaultId, "viewer");
    await sync(server, alice);
    await sync(server, bob);

    const { body } = await alice.call("createItem", { vaultId, content: login("made") });
    expect(body).toMatchObject({ vaultId, itemKeyVersion: 1, vaultKeyVersion: 1 });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    server.createItem(alice.id, body);
    const seen = await sync(server, bob);
    expect(seen.items.find((i) => i.id === body.id)).toMatchObject({
      name: "made",
      canEdit: false,
    });

    const denied = await bob.errorOf("createItem", { vaultId, content: login("nope") });
    expect(denied.code).toBe("vault_not_allowed");
    const invalid = await alice.errorOf("createItem", {
      vaultId,
      content: { type: "login", name: "" },
    });
    expect(invalid.code).toBe("invalid_item_content");
  });

  it("updates with the same item key and versions and stamps a changed password", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("site"));
    await sync(server, alice);
    const before = await alice.call("getItem", { id: item.id });
    const stamp = before.content?.type === "login" ? before.content.passwordUpdatedAt : undefined;

    // Same password: timestamp kept.
    const same = await alice.call("updateItem", {
      id: item.id,
      content: login("site renamed", { password: "pw-site" }),
    });
    expect(same.body).toMatchObject({
      wrappedKey: item.wrappedKey,
      itemKeyVersion: 1,
      vaultKeyVersion: 1,
      revision: 1,
    });
    server.updateItem(alice.id, item.id, same.body);
    await sync(server, alice);
    const kept = await alice.call("getItem", { id: item.id });
    expect(kept.content).toMatchObject({ name: "site renamed", passwordUpdatedAt: stamp });

    // New password: timestamp refreshed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const changed = await alice.call("updateItem", {
      id: item.id,
      content: login("site renamed", { password: "another" }),
    });
    server.updateItem(alice.id, item.id, changed.body);
    await sync(server, alice);
    const after = await alice.call("getItem", { id: item.id });
    expect(after.content?.type === "login" && after.content.passwordUpdatedAt).toBeGreaterThan(
      stamp as number,
    );
  });

  it("lets an explicit base revision through so the server can report a conflict", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("site"));
    await sync(server, alice);
    const { body } = await alice.call("updateItem", {
      id: item.id,
      content: login("site"),
      revision: 5,
    });
    expect(body.revision).toBe(5);
  });

  it("moves an item by re-wrapping its key under the target vault key", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const first = alice.creation.vault.id;
    const { vaultId: second, body: vaultBody } = await alice.call("createVault", {
      meta: { name: "Work", color: "violet" },
    });
    server.createVault(alice.id, vaultBody);
    const item = await addItem(server, alice, first, login("travel"));
    await sync(server, alice);

    const { body } = await alice.call("moveItem", { id: item.id, targetVaultId: second });
    expect(body).toMatchObject({ targetVaultId: second, vaultKeyVersion: 1, revision: 1 });
    server.items.set(item.id, {
      ...item,
      vaultId: second,
      wrappedKey: body.wrappedKey,
      revision: 2,
      updatedAt: server.tick(),
    });
    const snapshot = await sync(server, alice);
    expect(snapshot.items[0]).toMatchObject({ vaultId: second, name: "travel", readable: true });
    expect(snapshot.vaults.find((v) => v.id === second)).toMatchObject({
      name: "Work",
      color: "violet",
    });
  });

  it("creates and renames a vault", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const created = await alice.call("createVault", { meta: { name: "  Family  " } });
    server.createVault(alice.id, created.body);
    await sync(server, alice);
    const rename = await alice.call("updateVaultMeta", {
      vaultId: created.vaultId,
      meta: { name: "Household" },
    });
    expect(rename.body.keyVersion).toBe(1);
    const vault = server.vaults.get(created.vaultId);
    if (vault)
      server.vaults.set(vault.id, {
        ...vault,
        encryptedMeta: rename.body.encryptedMeta,
        updatedAt: server.tick(),
      });
    const snapshot = await sync(server, alice);
    expect(snapshot.vaults.map((v) => v.name).sort()).toEqual(["Household", "alice vault"]);
    const bad = await alice.errorOf("createVault", { meta: { name: "   " } });
    expect(bad.code).toBe("invalid_item_content");
  });
});

describe("vault worker: sharing", () => {
  it("gives a member access through the sealed vault key", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const vaultId = alice.creation.vault.id;
    const item = await addItem(server, alice, vaultId, login("shared"));
    await shareVault(server, alice, bob, vaultId, "editor");

    const snapshot = await sync(server, bob);
    expect(snapshot.vaults.find((v) => v.id === vaultId)).toMatchObject({
      myRole: "editor",
      isOwner: false,
      memberCount: 2,
    });
    const detail = await bob.call("getItem", { id: item.id });
    expect(detail.content).toMatchObject({ name: "shared", password: "pw-shared" });
    expect(snapshot.members.find((m) => m.isMe)?.email).toBe("bob@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("sealedKey");
  });

  it("gives a share recipient access to one item only, and lets an editor update it unchanged", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const vaultId = alice.creation.vault.id;
    const shared = await addItem(server, alice, vaultId, login("only this"));
    await addItem(server, alice, vaultId, login("private"));
    await sync(server, alice);

    const sealed = await alice.call("sealItemKeyFor", {
      itemId: shared.id,
      publicKey: bob.publicKey,
    });
    expect(sealed.keyVersion).toBe(1);
    // Bob already has his own vault; the shared item lives in Alice's.
    const share = server.shareItem(
      shared.id,
      bob.id,
      "editor",
      sealed.sealedKey,
      sealed.keyVersion,
    );

    const snapshot = await sync(server, bob);
    const visible = snapshot.items.filter((item) => item.vaultId === vaultId);
    expect(visible.map((item) => item.name)).toEqual(["only this"]);
    expect(visible[0]).toMatchObject({
      sharedWithMe: true,
      canEdit: true,
      canManage: false,
      canShare: false,
    });
    expect(snapshot.vaults.map((v) => v.id)).not.toContain(vaultId);

    const { body } = await bob.call("updateItem", {
      id: shared.id,
      content: login("only this", { notes: "edited" }),
    });
    expect(body).toMatchObject({
      wrappedKey: shared.wrappedKey,
      itemKeyVersion: 1,
      vaultKeyVersion: 1,
    });
    server.updateItem(bob.id, shared.id, body);
    await sync(server, alice);
    expect((await alice.call("getItem", { id: shared.id })).content).toMatchObject({
      notes: "edited",
    });

    // The share disappears: the item goes with it.
    const after = await bob.call("applySync", {
      response: {
        ...server.sync(bob.id),
        full: false,
        items: [],
        itemShares: [],
        vaults: [],
        members: [],
        deletions: [{ entity: "item_share", id: share.id, deletedAt: server.tick() }],
      },
    });
    expect(after.items.filter((item) => item.vaultId === vaultId)).toHaveLength(0);
    expect((await bob.errorOf("getItem", { id: shared.id })).code).toBe("item_not_found");
  });

  it("makes a viewer share recipient read-only", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const shared = await addItem(server, alice, alice.creation.vault.id, login("read only"));
    await sync(server, alice);
    const sealed = await alice.call("sealItemKeyFor", {
      itemId: shared.id,
      publicKey: bob.publicKey,
    });
    server.shareItem(shared.id, bob.id, "viewer", sealed.sealedKey, 1);
    const snapshot = await sync(server, bob);
    expect(snapshot.items.find((i) => i.id === shared.id)).toMatchObject({ canEdit: false });
    expect((await bob.errorOf("updateItem", { id: shared.id, content: login("x") })).code).toBe(
      "vault_not_allowed",
    );
    expect(
      (await bob.errorOf("moveItem", { id: shared.id, targetVaultId: bob.creation.vault.id })).code,
    ).toBe("vault_not_allowed");
  });

  it("only lets managers seal keys for others", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const vaultId = alice.creation.vault.id;
    const item = await addItem(server, alice, vaultId, login("x"));
    await shareVault(server, alice, bob, vaultId, "editor");
    await sync(server, bob);
    expect(
      (await bob.errorOf("sealVaultKeyFor", { vaultId, publicKey: alice.publicKey })).code,
    ).toBe("vault_not_allowed");
    expect(
      (await bob.errorOf("sealItemKeyFor", { itemId: item.id, publicKey: alice.publicKey })).code,
    ).toBe("vault_not_allowed");
  });

  it("opens a pending vault invitation to show its name", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const vaultId = alice.creation.vault.id;
    await sync(server, alice);
    const sealed = await alice.call("sealVaultKeyFor", { vaultId, publicKey: bob.publicKey });
    const pending: PendingShare = {
      kind: "vault",
      id: crypto.randomUUID(),
      vaultId,
      role: "viewer",
      keyVersion: 1,
      sealedKey: sealed.sealedKey,
      encryptedMeta: (server.vaults.get(vaultId) as { encryptedMeta: string }).encryptedMeta,
      invitedBy: alice.id,
      invitedByEmail: alice.email,
      createdAt: 1,
    };
    expect(await bob.call("openPendingShare", { pending })).toMatchObject({
      kind: "vault",
      readable: true,
      name: "alice vault",
    });
    // Sealed for somebody else: unreadable, not an error.
    expect(
      await alice.call("openPendingShare", {
        pending: { ...pending, sealedKey: sealed.sealedKey },
      }),
    ).toMatchObject({
      readable: false,
    });
  });
});

describe("vault worker: rotation", () => {
  async function setupVault() {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const carol = await newUser("carol", server);
    const dave = await newUser("dave", server);
    const vaultId = alice.creation.vault.id;
    const items = [
      await addItem(server, alice, vaultId, login("one")),
      await addItem(server, alice, vaultId, login("two")),
      await addItem(server, alice, vaultId, { type: "note", name: "three", notes: "n" }),
    ];
    server.trashItem(items[2]?.id as string, true);
    await shareVault(server, alice, bob, vaultId, "editor");
    const carolMember = await shareVault(server, alice, carol, vaultId, "viewer");
    // Dave holds a single-item share on "one".
    await sync(server, alice);
    const sealed = await alice.call("sealItemKeyFor", {
      itemId: items[0]?.id as string,
      publicKey: dave.publicKey,
    });
    // (Dave is not a vault member: the share is the only access.)
    const share = server.shareItem(items[0]?.id as string, dave.id, "viewer", sealed.sealedKey, 1);
    await sync(server, alice);
    await sync(server, bob);
    await sync(server, carol);
    await sync(server, dave);
    return { server, alice, bob, carol, dave, vaultId, items, carolMember, share };
  }

  /** What the server does on `finalize`, enough for the worker tests. */
  function finalize(server: FakeServer, vaultId: string, prepared: OpResult<"prepareRotation">) {
    const vault = server.vaults.get(vaultId);
    if (!vault) throw new Error("no vault");
    const now = server.tick();
    server.vaults.set(vaultId, {
      ...vault,
      keyVersion: prepared.newKeyVersion,
      encryptedMeta: prepared.finalize.encryptedMeta,
      rotationPending: false,
      updatedAt: now,
    });
    for (const chunk of prepared.chunks) {
      for (const rotated of chunk.items) {
        const item = server.items.get(rotated.id) as ItemWire;
        server.items.set(item.id, {
          ...item,
          itemKeyVersion: rotated.itemKeyVersion,
          wrappedKey: rotated.wrappedKey,
          vaultKeyVersion: rotated.vaultKeyVersion,
          encryptedData: rotated.encryptedData,
          revision: item.revision + 1,
          updatedAt: now,
        });
      }
    }
    for (const entry of prepared.finalize.memberKeys) {
      const member = server.members.get(entry.memberId);
      if (!member) throw new Error("unknown member");
      server.members.set(member.id, {
        ...member,
        sealedKey: entry.sealedKey,
        keyVersion: prepared.newKeyVersion,
        updatedAt: now,
      });
    }
    for (const entry of prepared.finalize.itemShareKeys) {
      const share = server.shares.get(entry.shareId);
      if (!share) throw new Error("unknown share");
      const item = server.items.get(share.itemId) as ItemWire;
      server.shares.set(share.id, {
        ...share,
        sealedKey: entry.sealedKey,
        keyVersion: item.itemKeyVersion,
        updatedAt: now,
      });
    }
  }

  it("re-encrypts everything and seals the new key for remaining members only", async () => {
    const { server, alice, bob, carol, dave, vaultId, items, carolMember } = await setupVault();

    // The server removed Carol (the owner's UI then starts the rotation).
    server.members.delete(carolMember.id);
    await alice.call("applySync", {
      response: {
        ...server.sync(alice.id),
        full: false,
        deletions: [{ entity: "vault_member", id: carolMember.id, deletedAt: server.tick() }],
      },
    });

    const prepared = await alice.call("prepareRotation", { vaultId });
    expect(prepared.newKeyVersion).toBe(2);
    expect(prepared.chunks).toHaveLength(1);
    expect(prepared.chunks[0]?.items).toHaveLength(3); // trashed note included
    expect(prepared.chunks[0]?.items.length).toBeLessThanOrEqual(MAX_ROTATION_CHUNK_ITEMS);
    for (const rotated of prepared.chunks[0]?.items ?? []) {
      expect(rotated.itemKeyVersion).toBe(2);
      expect(rotated.vaultKeyVersion).toBe(2);
      expect(rotated.revision).toBe(1);
    }
    expect(prepared.finalize.memberKeys).toHaveLength(2); // alice + bob
    expect(prepared.finalize.itemShareKeys).toHaveLength(1); // dave's share
    // No key material in the result besides sealed boxes.
    expect(JSON.stringify(prepared)).not.toContain("pw-one");

    finalize(server, vaultId, prepared);
    await alice.call("commitRotation", { vaultId });
    expect((await alice.errorOf("commitRotation", { vaultId })).code).toBe("no_pending_rotation");

    // Alice (committed key), Bob (opens the re-sealed key) and Dave (item share) read the new data.
    const aliceView = await sync(server, alice);
    expect(aliceView.vaults.find((v) => v.id === vaultId)?.keyVersion).toBe(2);
    expect(aliceView.items.every((item) => item.readable)).toBe(true);
    const bobView = await sync(server, bob);
    expect(bobView.items.filter((i) => i.vaultId === vaultId).every((item) => item.readable)).toBe(
      true,
    );
    expect((await bob.call("getItem", { id: items[0]?.id as string })).content).toMatchObject({
      name: "one",
      password: "pw-one",
    });
    const daveView = await sync(server, dave);
    expect(daveView.items).toHaveLength(1);
    expect(daveView.items[0]).toMatchObject({ readable: true, name: "one" });

    // Carol only has the old key (version 1): the new one was never sealed for her.
    expect(server.sync(carol.id).vaults.map((v) => v.id)).not.toContain(vaultId);
    const sealedForOthers = prepared.finalize.memberKeys.map((entry) => entry.sealedKey);
    const carolKeys = carol.state.requireUnlocked();
    for (const sealedKey of sealedForOthers) {
      await expect(
        openSealedKey(sealedKey, carolKeys.publicKey, carolKeys.privateKey, {
          type: "vault",
          id: vaultId,
          keyVersion: 2,
        }),
      ).rejects.toBeTruthy();
    }
  });

  it("chunks large vaults and reports the item that cannot be decrypted", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const vaultId = alice.creation.vault.id;
    for (let i = 0; i < MAX_ROTATION_CHUNK_ITEMS + 5; i++) {
      await addItem(server, alice, vaultId, { type: "note", name: `n${i}`, notes: "x" });
    }
    await sync(server, alice);
    const prepared = await alice.call("prepareRotation", { vaultId });
    expect(prepared.chunks.map((chunk) => chunk.items.length)).toEqual([
      MAX_ROTATION_CHUNK_ITEMS,
      5,
    ]);
    await alice.call("discardRotation", { vaultId });
    expect((await alice.errorOf("commitRotation", { vaultId })).code).toBe("no_pending_rotation");

    const victim = [...server.items.values()][0] as ItemWire;
    server.items.set(victim.id, {
      ...victim,
      encryptedData: `${victim.encryptedData.slice(0, -4)}AAAA`,
    });
    await sync(server, alice);
    const error = await alice.errorOf("prepareRotation", { vaultId });
    expect(error.code).toBe("rotation_item_unreadable");
    expect(error.message).toContain(victim.id);
  });

  it("only lets managers rotate", async () => {
    const { bob, vaultId } = await setupVault();
    expect((await bob.errorOf("prepareRotation", { vaultId })).code).toBe("vault_not_allowed");
  });

  it("rotates one item key after an item share is revoked", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const bob = await newUser("bob", server);
    const dave = await newUser("dave", server);
    const vaultId = alice.creation.vault.id;
    const item = await addItem(server, alice, vaultId, login("pair"));
    await sync(server, alice);
    const forBob = await alice.call("sealItemKeyFor", {
      itemId: item.id,
      publicKey: bob.publicKey,
    });
    const forDave = await alice.call("sealItemKeyFor", {
      itemId: item.id,
      publicKey: dave.publicKey,
    });
    const bobShare = server.shareItem(item.id, bob.id, "viewer", forBob.sealedKey, 1);
    const daveShare = server.shareItem(item.id, dave.id, "viewer", forDave.sealedKey, 1);
    await sync(server, alice);

    const { body } = await alice.call("prepareItemKeyRotation", {
      itemId: item.id,
      removedShareId: daveShare.id,
    });
    expect(body.itemKeyVersion).toBe(2);
    expect(body.vaultKeyVersion).toBe(1);
    expect(body.revision).toBe(1);
    expect(body.shareKeys?.map((entry) => entry.shareId)).toEqual([bobShare.id]);

    server.shares.delete(daveShare.id);
    server.updateItem(alice.id, item.id, body);

    // Bob can read the re-encrypted item with the re-sealed key.
    await sync(server, bob);
    expect((await bob.call("getItem", { id: item.id })).content).toMatchObject({ name: "pair" });

    // Dave's old key (version 1) does not decrypt version 2 any more.
    const daveSync = await dave.call("applySync", {
      response: {
        ...server.sync(dave.id),
        itemShares: [{ ...daveShare, keyVersion: 1 }],
        items: [server.items.get(item.id) as ItemWire],
      },
    });
    expect(daveSync.items[0]).toMatchObject({ readable: false });
  });
});

describe("vault worker: lock", () => {
  it("drops the store and every key when the worker locks", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("gone"));
    await sync(server, alice);
    await alice.call("getItem", { id: item.id });

    await alice.call("lock");
    expect((await alice.errorOf("getItem", { id: item.id })).code).toBe("locked");
    expect((await alice.errorOf("applySync", { response: server.sync(alice.id) })).code).toBe(
      "locked",
    );
    expect(alice.state.vaultKeys.size).toBe(0);

    // A new unlock starts from an empty store.
    await alice.call("unlock", { password: PASSWORD, keyBundle: alice.bundle });
    expect((await alice.errorOf("getItem", { id: item.id })).code).toBe("item_not_found");
  });

  it("clearVaultState empties the store without locking", async () => {
    const server = new FakeServer();
    const alice = await newUser("alice", server);
    const item = await addItem(server, alice, alice.creation.vault.id, login("x"));
    await sync(server, alice);
    await alice.call("clearVaultState");
    expect((await alice.errorOf("getItem", { id: item.id })).code).toBe("item_not_found");
    expect((await alice.call("isUnlocked")).unlocked).toBe(true);
  });
});
