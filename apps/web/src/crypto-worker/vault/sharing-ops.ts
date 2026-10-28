import {
  decryptVaultMeta,
  type EncryptedItem,
  encryptVaultMeta,
  generateKey,
  openSealedKey,
  reencryptItem,
  sealKey,
  wipe,
} from "@pm/crypto";
import {
  MAX_ROTATION_CHUNK_ITEMS,
  type PendingShare,
  type RotatedItem,
  type UpdateItemRequest,
  vaultMetaSchema,
} from "@pm/shared";
import type { WorkerState } from "../state.ts";
import { type PendingShareView, type PreparedRotation, VAULT_ERROR } from "../vault-protocol.ts";
import { openItemKey } from "./item-ops.ts";
import {
  cancelled,
  findVaultKey,
  requireItem,
  requireVault,
  requireVaultKey,
  roleAtLeast,
  setVaultKey,
  type VaultStore,
  vaultError,
} from "./store.ts";

/** Upper bound of ciphertext characters per rotation chunk, on top of the item count cap. */
const MAX_CHUNK_CHARS = 2_000_000;

export async function sealVaultKey(
  state: WorkerState,
  store: VaultStore,
  args: { vaultId: string; publicKey: string },
): Promise<{ keyVersion: number; sealedKey: string }> {
  state.requireUnlocked();
  const vault = requireVault(store, args.vaultId);
  if (!roleAtLeast(vault.myRole, "manager")) {
    throw vaultError(VAULT_ERROR.notAllowed, "Only managers can invite members");
  }
  const vk = requireVaultKey(state, vault.id, vault.keyVersion);
  const sealedKey = await sealKey(args.publicKey, {
    type: "vault",
    id: vault.id,
    keyVersion: vault.keyVersion,
    key: vk,
  });
  return { keyVersion: vault.keyVersion, sealedKey };
}

export async function sealItemKey(
  state: WorkerState,
  store: VaultStore,
  args: { itemId: string; publicKey: string },
): Promise<{ keyVersion: number; sealedKey: string }> {
  state.requireUnlocked();
  const { item, vault, ik } = await openItemKey(state, store, args.itemId);
  try {
    if (!vault || !roleAtLeast(vault.myRole, "manager")) {
      throw vaultError(VAULT_ERROR.notAllowed, "Only managers can share an item");
    }
    const sealedKey = await sealKey(args.publicKey, {
      type: "item",
      id: item.id,
      keyVersion: item.itemKeyVersion,
      key: ik,
    });
    return { keyVersion: item.itemKeyVersion, sealedKey };
  } finally {
    wipe(ik);
  }
}

/** Split into chunks of at most `MAX_ROTATION_CHUNK_ITEMS` items and `MAX_CHUNK_CHARS` characters. */
function chunkItems(items: RotatedItem[]): RotatedItem[][] {
  const chunks: RotatedItem[][] = [];
  let current: RotatedItem[] = [];
  let chars = 0;
  for (const item of items) {
    const size = item.encryptedData.length + item.wrappedKey.length;
    if (
      current.length > 0 &&
      (current.length >= MAX_ROTATION_CHUNK_ITEMS || chars + size > MAX_CHUNK_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Vault key rotation (PLAN.md 11.4): new vault key at `keyVersion + 1`, new item keys for every
 * item (trashed ones included), contents and metadata re-encrypted, and the new keys sealed for
 * every member (pending ones too) and every item share on the vault's items, using the public
 * keys from the last sync. The new vault key waits in the store until `commitRotation`.
 */
export async function prepareVaultRotation(
  state: WorkerState,
  store: VaultStore,
  args: { vaultId: string },
): Promise<PreparedRotation> {
  state.requireUnlocked();
  const epoch = state.epoch;
  const vault = requireVault(store, args.vaultId);
  if (!roleAtLeast(vault.myRole, "manager")) {
    throw vaultError(VAULT_ERROR.notAllowed, "Only managers can rotate the vault key");
  }
  const oldVk = requireVaultKey(state, vault.id, vault.keyVersion);
  const newKeyVersion = vault.keyVersion + 1;

  // A previous attempt that was never committed is replaced.
  const previous = store.pendingRotations.get(vault.id);
  if (previous) wipe(previous.newVk);
  store.pendingRotations.delete(vault.id);

  const newVk = await generateKey();
  const rotated = new Map<string, EncryptedItem>();
  try {
    const rawMeta = await decryptVaultMeta(oldVk, vault.id, vault.keyVersion, vault.encryptedMeta);
    const meta = vaultMetaSchema.safeParse(rawMeta);
    const encryptedMeta = await encryptVaultMeta(
      newVk,
      vault.id,
      newKeyVersion,
      meta.success ? meta.data : rawMeta,
    );

    const items = store.itemsOf(vault.id).sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      const itemVk = findVaultKey(state, vault.id, item.vaultKeyVersion);
      if (!itemVk) {
        throw vaultError(
          VAULT_ERROR.rotationItemUnreadable,
          `Item ${item.id} is encrypted under a key this device does not have.`,
        );
      }
      try {
        rotated.set(
          item.id,
          await reencryptItem({
            vaultId: vault.id,
            item: {
              id: item.id,
              itemKeyVersion: item.itemKeyVersion,
              wrappedKey: item.wrappedKey,
              encryptedData: item.encryptedData,
            },
            oldVk: itemVk,
            oldVaultKeyVersion: item.vaultKeyVersion,
            newVk,
            newVaultKeyVersion: newKeyVersion,
          }),
        );
      } catch (error) {
        throw vaultError(
          VAULT_ERROR.rotationItemUnreadable,
          `Item ${item.id} cannot be decrypted, so the vault cannot be rotated. Delete it permanently and try again.`,
          { cause: error },
        );
      }
      if (state.epoch !== epoch) throw cancelled();
    }

    const wires: RotatedItem[] = items.map((item) => {
      const entry = rotated.get(item.id) as EncryptedItem;
      return {
        id: item.id,
        revision: item.revision,
        itemKeyVersion: entry.wire.itemKeyVersion,
        wrappedKey: entry.wire.wrappedKey,
        vaultKeyVersion: entry.wire.vaultKeyVersion,
        encryptedData: entry.wire.encryptedData,
      };
    });

    const memberKeys = [];
    for (const member of store.membersOf(vault.id)) {
      memberKeys.push({
        memberId: member.id,
        sealedKey: await sealKey(member.publicKey, {
          type: "vault",
          id: vault.id,
          keyVersion: newKeyVersion,
          key: newVk,
        }),
      });
    }
    const itemShareKeys = [];
    for (const item of items) {
      const entry = rotated.get(item.id) as EncryptedItem;
      for (const share of store.sharesOf(item.id)) {
        itemShareKeys.push({
          shareId: share.id,
          sealedKey: await sealKey(share.publicKey, {
            type: "item",
            id: item.id,
            keyVersion: entry.wire.itemKeyVersion,
            key: entry.ik,
          }),
        });
      }
    }

    store.pendingRotations.set(vault.id, { newVk, newKeyVersion });
    return {
      vaultId: vault.id,
      newKeyVersion,
      chunks: chunkItems(wires).map((chunk) => ({
        step: "chunk" as const,
        newKeyVersion,
        items: chunk,
      })),
      finalize: {
        step: "finalize",
        newKeyVersion,
        encryptedMeta,
        memberKeys,
        itemShareKeys,
      },
    };
  } catch (error) {
    wipe(newVk);
    throw error;
  } finally {
    for (const entry of rotated.values()) wipe(entry.ik);
  }
}

export function commitVaultRotation(
  state: WorkerState,
  store: VaultStore,
  args: { vaultId: string },
): void {
  const pending = store.pendingRotations.get(args.vaultId);
  if (!pending) {
    throw vaultError(VAULT_ERROR.noPendingRotation, "No rotation is waiting to be committed");
  }
  store.pendingRotations.delete(args.vaultId);
  setVaultKey(state, args.vaultId, pending.newKeyVersion, pending.newVk);
}

export function discardVaultRotation(store: VaultStore, args: { vaultId: string }): void {
  const pending = store.pendingRotations.get(args.vaultId);
  if (pending) wipe(pending.newVk);
  store.pendingRotations.delete(args.vaultId);
}

/**
 * Item share revoked (PLAN.md 11.4): a new item key for that one item, wrapped under the vault's
 * current key, and sealed for every remaining share. Goes out as `PUT /items/:id`.
 */
export async function prepareItemKeyRotation(
  state: WorkerState,
  store: VaultStore,
  args: { itemId: string; removedShareId: string },
): Promise<UpdateItemRequest> {
  state.requireUnlocked();
  const item = requireItem(store, args.itemId);
  const vault = requireVault(store, item.vaultId);
  if (!roleAtLeast(vault.myRole, "manager")) {
    throw vaultError(VAULT_ERROR.notAllowed, "Only managers can revoke item shares");
  }
  store.itemShares.delete(args.removedShareId);
  const oldVk = requireVaultKey(state, vault.id, item.vaultKeyVersion);
  const newVk = requireVaultKey(state, vault.id, vault.keyVersion);
  const rotated = await reencryptItem({
    vaultId: vault.id,
    item: {
      id: item.id,
      itemKeyVersion: item.itemKeyVersion,
      wrappedKey: item.wrappedKey,
      encryptedData: item.encryptedData,
    },
    oldVk,
    oldVaultKeyVersion: item.vaultKeyVersion,
    newVk,
    newVaultKeyVersion: vault.keyVersion,
  });
  try {
    const shareKeys = [];
    for (const share of store.sharesOf(item.id)) {
      shareKeys.push({
        shareId: share.id,
        sealedKey: await sealKey(share.publicKey, {
          type: "item",
          id: item.id,
          keyVersion: rotated.wire.itemKeyVersion,
          key: rotated.ik,
        }),
      });
    }
    return {
      itemKeyVersion: rotated.wire.itemKeyVersion,
      wrappedKey: rotated.wire.wrappedKey,
      vaultKeyVersion: rotated.wire.vaultKeyVersion,
      encryptedData: rotated.wire.encryptedData,
      revision: item.revision,
      shareKeys,
    };
  } finally {
    wipe(rotated.ik);
  }
}

/** Show an invitation's vault name before it is accepted. */
export async function openPending(
  state: WorkerState,
  args: { pending: PendingShare },
): Promise<PendingShareView> {
  const me = state.requireUnlocked();
  const { pending } = args;
  if (pending.kind === "item") {
    try {
      const key = await openSealedKey(pending.sealedKey, me.publicKey, me.privateKey, {
        type: "item",
        id: pending.itemId,
        keyVersion: pending.keyVersion,
      });
      wipe(key);
      return { kind: "item", id: pending.id, readable: true };
    } catch {
      return { kind: "item", id: pending.id, readable: false };
    }
  }
  try {
    const vk = await openSealedKey(pending.sealedKey, me.publicKey, me.privateKey, {
      type: "vault",
      id: pending.vaultId,
      keyVersion: pending.keyVersion,
    });
    try {
      const raw = await decryptVaultMeta(
        vk,
        pending.vaultId,
        pending.keyVersion,
        pending.encryptedMeta,
      );
      const meta = vaultMetaSchema.parse(raw);
      const view: PendingShareView = {
        kind: "vault",
        id: pending.id,
        readable: true,
        name: meta.name,
      };
      if (meta.icon !== undefined) view.icon = meta.icon;
      if (meta.color !== undefined) view.color = meta.color;
      return view;
    } finally {
      wipe(vk);
    }
  } catch {
    return { kind: "vault", id: pending.id, readable: false, name: "Unreadable vault" };
  }
}
