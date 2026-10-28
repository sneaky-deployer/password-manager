import { CryptoError, wipe } from "@pm/crypto";
import {
  type ItemContent,
  type ItemShareWire,
  type ItemWire,
  VAULT_ROLES,
  type VaultMemberWire,
  type VaultMeta,
  type VaultRole,
  type VaultWire,
} from "@pm/shared";
import { CRYPTO_ERROR } from "../protocol.ts";
import type { WorkerState } from "../state.ts";
import { VAULT_ERROR } from "../vault-protocol.ts";

/** Decrypted content of one item, or null when it could not be decrypted or validated. */
export interface CachedItem {
  /** The ciphertext this was decrypted from; a different value means the cache is stale. */
  encryptedData: string;
  wrappedKey: string;
  itemKeyVersion: number;
  vaultKeyVersion: number;
  content: ItemContent | null;
}

export interface CachedMeta {
  encryptedMeta: string;
  keyVersion: number;
  meta: VaultMeta | null;
}

export interface PendingRotation {
  newVk: Uint8Array;
  newKeyVersion: number;
}

/**
 * Everything the vault ops keep between calls: the last synced records (ciphertext), the keys of
 * items shared to me, and the decrypted caches. Vault keys live in `WorkerState.vaultKeys`. All of
 * it stays in the worker and is dropped on lock.
 */
export class VaultStore {
  vaults = new Map<string, VaultWire>();
  members = new Map<string, VaultMemberWire>();
  items = new Map<string, ItemWire>();
  itemShares = new Map<string, ItemShareWire>();
  /** itemId -> item key version -> item key, from item shares addressed to me. */
  itemKeys = new Map<string, Map<number, Uint8Array>>();
  decrypted = new Map<string, CachedItem>();
  metas = new Map<string, CachedMeta>();
  pendingRotations = new Map<string, PendingRotation>();

  clear(): void {
    for (const versions of this.itemKeys.values()) {
      for (const key of versions.values()) wipe(key);
    }
    for (const rotation of this.pendingRotations.values()) wipe(rotation.newVk);
    this.vaults.clear();
    this.members.clear();
    this.items.clear();
    this.itemShares.clear();
    this.itemKeys.clear();
    this.decrypted.clear();
    this.metas.clear();
    this.pendingRotations.clear();
  }

  dropItemKeys(itemId: string): void {
    const versions = this.itemKeys.get(itemId);
    if (!versions) return;
    for (const key of versions.values()) wipe(key);
    this.itemKeys.delete(itemId);
  }

  setItemKey(itemId: string, version: number, key: Uint8Array): void {
    let versions = this.itemKeys.get(itemId);
    if (!versions) {
      versions = new Map();
      this.itemKeys.set(itemId, versions);
    }
    wipe(versions.get(version));
    versions.set(version, key);
  }

  membersOf(vaultId: string): VaultMemberWire[] {
    return [...this.members.values()].filter((member) => member.vaultId === vaultId);
  }

  itemsOf(vaultId: string): ItemWire[] {
    return [...this.items.values()].filter((item) => item.vaultId === vaultId);
  }

  sharesOf(itemId: string): ItemShareWire[] {
    return [...this.itemShares.values()].filter((share) => share.itemId === itemId);
  }
}

/** Raise a coded error the UI can branch on (see `VAULT_ERROR`). */
export function vaultError(code: string, message: string, options?: ErrorOptions): CryptoError {
  return new CryptoError(code, message, options);
}

export function cancelled(): CryptoError {
  return new CryptoError(CRYPTO_ERROR.cancelled, "The operation was cancelled by a lock");
}

export function roleAtLeast(role: VaultRole, minimum: VaultRole): boolean {
  return VAULT_ROLES.indexOf(role) >= VAULT_ROLES.indexOf(minimum);
}

/** The vault key for `version`, or undefined. */
export function findVaultKey(
  state: WorkerState,
  vaultId: string,
  version: number,
): Uint8Array | undefined {
  return state.vaultKeys.get(vaultId)?.get(version);
}

export function requireVault(store: VaultStore, vaultId: string): VaultWire {
  const vault = store.vaults.get(vaultId);
  if (!vault) throw vaultError(VAULT_ERROR.vaultNotFound, "That vault is not available");
  return vault;
}

export function requireItem(store: VaultStore, itemId: string): ItemWire {
  const item = store.items.get(itemId);
  if (!item) throw vaultError(VAULT_ERROR.itemNotFound, "That item is not available");
  return item;
}

export function requireVaultKey(state: WorkerState, vaultId: string, version: number): Uint8Array {
  const key = findVaultKey(state, vaultId, version);
  if (!key) {
    throw vaultError(VAULT_ERROR.keyMissing, "The vault key is not available. Sync and try again.");
  }
  return key;
}

export function setVaultKey(
  state: WorkerState,
  vaultId: string,
  version: number,
  key: Uint8Array,
): void {
  let versions = state.vaultKeys.get(vaultId);
  if (!versions) {
    versions = new Map();
    state.vaultKeys.set(vaultId, versions);
  }
  versions.set(version, key);
}

/** Serialise async ops so a sync and a write never interleave on the same store. */
export function createExclusive() {
  let tail: Promise<unknown> = Promise.resolve();
  return function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
