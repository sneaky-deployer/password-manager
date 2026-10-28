import { decryptItem, decryptVaultMeta, openSealedKey, unwrapItemKey, wipe } from "@pm/crypto";
import {
  type ItemWire,
  itemContentSchema,
  type SyncResponse,
  type VaultWire,
  vaultMetaSchema,
} from "@pm/shared";
import type { WorkerState } from "../state.ts";
import type { VaultSnapshot } from "../vault-protocol.ts";
import { type CachedItem, cancelled, findVaultKey, setVaultKey, type VaultStore } from "./store.ts";
import { buildSnapshot } from "./views.ts";

/** True when `incoming` is not older than `current` (sync re-sends a 2 s overlap). */
function isNewerOrSame(
  incoming: { updatedAt: number },
  current: { updatedAt: number } | undefined,
): boolean {
  return !current || incoming.updatedAt >= current.updatedAt;
}

function itemIsNewerOrSame(incoming: ItemWire, current: ItemWire | undefined): boolean {
  if (!current) return true;
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  return incoming.updatedAt >= current.updatedAt;
}

/**
 * Apply a sync response to the store (PLAN.md 13, "Sync and tombstones"):
 * 1. tombstones first (an item moved A -> B -> A arrives as a deletion and an upsert),
 * 2. then upserts, idempotently: a row is only replaced by an equal or newer one,
 * 3. open the vault keys and item keys my memberships and shares carry,
 * 4. decrypt what changed (vault metadata, item content). A record that fails to decrypt or
 *    validate is kept as unreadable; it never throws.
 * `full: true` replaces everything: whatever the snapshot does not contain is dropped.
 */
export async function applySyncResponse(
  state: WorkerState,
  store: VaultStore,
  response: SyncResponse,
): Promise<VaultSnapshot> {
  const me = state.requireUnlocked();
  const epoch = state.epoch;
  const stillUnlocked = () => {
    if (state.epoch !== epoch) throw cancelled();
  };

  // 1. Deletions.
  for (const deletion of response.deletions) {
    switch (deletion.entity) {
      case "vault":
        store.vaults.delete(deletion.id);
        break;
      case "item":
        store.items.delete(deletion.id);
        break;
      case "vault_member":
        store.members.delete(deletion.id);
        break;
      case "item_share":
        store.itemShares.delete(deletion.id);
        break;
    }
  }

  // 2. Upserts.
  for (const vault of response.vaults) {
    if (isNewerOrSame(vault, store.vaults.get(vault.id))) store.vaults.set(vault.id, vault);
  }
  for (const member of response.members) {
    if (isNewerOrSame(member, store.members.get(member.id))) {
      // Keep my sealed key when an older row without it is replaced (only my row carries one).
      const previous = store.members.get(member.id);
      store.members.set(
        member.id,
        member.sealedKey || !previous?.sealedKey
          ? member
          : { ...member, sealedKey: previous.sealedKey },
      );
    }
  }
  for (const item of response.items) {
    if (itemIsNewerOrSame(item, store.items.get(item.id))) store.items.set(item.id, item);
  }
  for (const share of response.itemShares) {
    if (isNewerOrSame(share, store.itemShares.get(share.id))) {
      const previous = store.itemShares.get(share.id);
      store.itemShares.set(
        share.id,
        share.sealedKey || !previous?.sealedKey
          ? share
          : { ...share, sealedKey: previous.sealedKey },
      );
    }
  }

  if (response.full) sweepMissing(store, response);
  prune(state, store, me.userId);

  // 3. Keys.
  await openVaultKeys(state, store, me, stillUnlocked);
  await openItemKeys(store, me, stillUnlocked);

  // 4. Decrypt what changed.
  for (const vault of store.vaults.values()) {
    await decryptMeta(state, store, vault);
    stillUnlocked();
  }
  for (const item of store.items.values()) {
    await decryptOneItem(state, store, item);
    stillUnlocked();
  }

  return buildSnapshot(store, me.userId);
}

/** After a full sync: drop every record the snapshot did not contain. */
function sweepMissing(store: VaultStore, response: SyncResponse): void {
  const keep = <T extends { id: string }>(map: Map<string, unknown>, rows: T[]) => {
    const ids = new Set(rows.map((row) => row.id));
    for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
  };
  keep(store.vaults, response.vaults);
  keep(store.members, response.members);
  keep(store.items, response.items);
  keep(store.itemShares, response.itemShares);
}

/**
 * Remove what is no longer reachable: members of vaults I left, items of vaults I left unless a
 * share of mine still gives access, shares of vanished items, and the keys/caches of all of it.
 */
function prune(state: WorkerState, store: VaultStore, userId: string): void {
  for (const [id, member] of [...store.members]) {
    if (!store.vaults.has(member.vaultId)) store.members.delete(id);
  }
  const mine = new Set<string>();
  for (const share of store.itemShares.values()) {
    if (share.userId === userId && share.status === "active") mine.add(share.itemId);
  }
  for (const [id, item] of [...store.items]) {
    if (!store.vaults.has(item.vaultId) && !mine.has(id)) store.items.delete(id);
  }
  for (const [id, share] of [...store.itemShares]) {
    if (!store.items.has(share.itemId)) store.itemShares.delete(id);
  }
  for (const id of [...store.decrypted.keys()]) {
    if (!store.items.has(id)) store.decrypted.delete(id);
  }
  for (const id of [...store.itemKeys.keys()]) {
    if (!store.items.has(id) || !mine.has(id)) store.dropItemKeys(id);
  }
  for (const id of [...store.metas.keys()]) {
    if (!store.vaults.has(id)) store.metas.delete(id);
  }
  for (const [vaultId, versions] of [...state.vaultKeys]) {
    if (store.vaults.has(vaultId)) continue;
    for (const key of versions.values()) wipe(key);
    state.vaultKeys.delete(vaultId);
  }
}

type Active = ReturnType<WorkerState["requireUnlocked"]>;

/** Open a sealed key; null when it does not open or is not the key the record claims. */
async function tryOpen(
  sealed: string,
  me: Active,
  expected: { type: "vault" | "item"; id: string; keyVersion: number },
): Promise<Uint8Array | null> {
  try {
    return await openSealedKey(sealed, me.publicKey, me.privateKey, expected);
  } catch {
    return null;
  }
}

async function openVaultKeys(
  state: WorkerState,
  store: VaultStore,
  me: Active,
  stillUnlocked: () => void,
): Promise<void> {
  for (const member of store.members.values()) {
    if (member.userId !== me.userId || member.status !== "active" || !member.sealedKey) continue;
    if (findVaultKey(state, member.vaultId, member.keyVersion)) continue;
    const key = await tryOpen(member.sealedKey, me, {
      type: "vault",
      id: member.vaultId,
      keyVersion: member.keyVersion,
    });
    try {
      stillUnlocked();
    } catch (error) {
      wipe(key);
      throw error;
    }
    // A vault whose key does not open stays listed as unreadable, and so do its items.
    if (key) setVaultKey(state, member.vaultId, member.keyVersion, key);
  }
}

async function openItemKeys(store: VaultStore, me: Active, stillUnlocked: () => void) {
  for (const share of store.itemShares.values()) {
    if (share.userId !== me.userId || share.status !== "active" || !share.sealedKey) continue;
    if (store.itemKeys.get(share.itemId)?.has(share.keyVersion)) continue;
    const key = await tryOpen(share.sealedKey, me, {
      type: "item",
      id: share.itemId,
      keyVersion: share.keyVersion,
    });
    try {
      stillUnlocked();
    } catch (error) {
      wipe(key);
      throw error;
    }
    if (key) store.setItemKey(share.itemId, share.keyVersion, key);
  }
}

async function decryptMeta(state: WorkerState, store: VaultStore, vault: VaultWire): Promise<void> {
  const cached = store.metas.get(vault.id);
  if (
    cached &&
    cached.encryptedMeta === vault.encryptedMeta &&
    cached.keyVersion === vault.keyVersion &&
    cached.meta
  ) {
    return;
  }
  const vk = findVaultKey(state, vault.id, vault.keyVersion);
  let meta = null;
  if (vk) {
    try {
      const raw = await decryptVaultMeta(vk, vault.id, vault.keyVersion, vault.encryptedMeta);
      const parsed = vaultMetaSchema.safeParse(raw);
      meta = parsed.success ? parsed.data : null;
    } catch {
      meta = null;
    }
  }
  store.metas.set(vault.id, {
    encryptedMeta: vault.encryptedMeta,
    keyVersion: vault.keyVersion,
    meta,
  });
}

/** The item key: unwrapped from the vault key, or taken from an item share addressed to me. */
async function resolveItemKey(
  state: WorkerState,
  store: VaultStore,
  item: ItemWire,
): Promise<Uint8Array | null> {
  if (store.vaults.has(item.vaultId)) {
    const vk = findVaultKey(state, item.vaultId, item.vaultKeyVersion);
    if (vk) {
      try {
        return await unwrapItemKey(
          vk,
          item.vaultId,
          item.id,
          item.vaultKeyVersion,
          item.wrappedKey,
        );
      } catch {
        return null;
      }
    }
    return null;
  }
  const shared = store.itemKeys.get(item.id)?.get(item.itemKeyVersion);
  // Copy: callers wipe what they get, the share key stays cached.
  return shared ? new Uint8Array(shared) : null;
}

async function decryptOneItem(state: WorkerState, store: VaultStore, item: ItemWire) {
  const cached = store.decrypted.get(item.id);
  if (
    cached &&
    cached.encryptedData === item.encryptedData &&
    cached.wrappedKey === item.wrappedKey &&
    cached.itemKeyVersion === item.itemKeyVersion &&
    cached.vaultKeyVersion === item.vaultKeyVersion &&
    cached.content
  ) {
    return;
  }
  const entry: CachedItem = {
    encryptedData: item.encryptedData,
    wrappedKey: item.wrappedKey,
    itemKeyVersion: item.itemKeyVersion,
    vaultKeyVersion: item.vaultKeyVersion,
    content: null,
  };
  const ik = await resolveItemKey(state, store, item);
  if (ik) {
    try {
      const raw = await decryptItem(ik, item.id, item.itemKeyVersion, item.encryptedData);
      const parsed = itemContentSchema.safeParse(raw);
      entry.content = parsed.success ? parsed.data : null;
    } catch {
      entry.content = null;
    } finally {
      wipe(ik);
    }
  }
  store.decrypted.set(item.id, entry);
}
