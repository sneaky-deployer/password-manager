import { aad } from "./aad.ts";
import { utf8Decode, utf8Encode } from "./encoding.ts";
import { open, seal } from "./envelope.ts";
import { DecryptionError, ItemTooLargeError } from "./errors.ts";
import { assertKey, generateKey } from "./keys.ts";
import type { EncryptedItemWire } from "./types.ts";

/** Maximum JSON plaintext of one item (UTF-8 bytes). */
export const MAX_ITEM_PLAINTEXT_BYTES = 64 * 1024;

export async function wrapItemKey(
  vk: Uint8Array,
  vaultId: string,
  itemId: string,
  vaultKeyVersion: number,
  ik: Uint8Array,
): Promise<string> {
  assertKey("ik", ik);
  return seal(vk, ik, aad.itemKey(vaultId, itemId, vaultKeyVersion));
}

export async function unwrapItemKey(
  vk: Uint8Array,
  vaultId: string,
  itemId: string,
  vaultKeyVersion: number,
  wrappedKey: string,
): Promise<Uint8Array> {
  const ik = await open(vk, wrappedKey, aad.itemKey(vaultId, itemId, vaultKeyVersion));
  if (ik.length !== 32) throw new DecryptionError("Malformed item key");
  return ik;
}

/** JSON-encode `content` and encrypt it under `ik`. Throws `ItemTooLargeError` above 64 KiB. */
export async function encryptItem(
  ik: Uint8Array,
  itemId: string,
  itemKeyVersion: number,
  content: unknown,
): Promise<string> {
  const json = JSON.stringify(content);
  if (json === undefined) throw new TypeError("Item content is not JSON-serializable");
  const plaintext = utf8Encode(json);
  if (plaintext.length > MAX_ITEM_PLAINTEXT_BYTES) throw new ItemTooLargeError();
  try {
    return await seal(ik, plaintext, aad.item(itemId, itemKeyVersion));
  } finally {
    plaintext.fill(0);
  }
}

/** Decrypt and JSON-parse. The caller validates the result with zod. */
export async function decryptItem(
  ik: Uint8Array,
  itemId: string,
  itemKeyVersion: number,
  encryptedData: string,
): Promise<unknown> {
  const plaintext = await open(ik, encryptedData, aad.item(itemId, itemKeyVersion));
  try {
    return JSON.parse(utf8Decode(plaintext));
  } catch (error) {
    throw new DecryptionError("Malformed item content", { cause: error });
  } finally {
    plaintext.fill(0);
  }
}

export interface EncryptedItem {
  /** The item key; keep it in memory only (needed to share the item). */
  ik: Uint8Array;
  wire: EncryptedItemWire;
}

export interface BuildItemParams {
  vk: Uint8Array;
  vaultId: string;
  vaultKeyVersion: number;
  itemId: string;
  itemKeyVersion: number;
  content: unknown;
}

/** Fresh random IK, content encrypted under it, IK wrapped under `vk`. */
export async function buildEncryptedItem(params: BuildItemParams): Promise<EncryptedItem> {
  const { vk, vaultId, vaultKeyVersion, itemId, itemKeyVersion, content } = params;
  const ik = await generateKey();
  const encryptedData = await encryptItem(ik, itemId, itemKeyVersion, content);
  const wrappedKey = await wrapItemKey(vk, vaultId, itemId, vaultKeyVersion, ik);
  return {
    ik,
    wire: { id: itemId, vaultId, itemKeyVersion, wrappedKey, vaultKeyVersion, encryptedData },
  };
}

/** New item: item key version 1. The returned `wire` is the create-request body. */
export async function createEncryptedItem(params: {
  vk: Uint8Array;
  vaultId: string;
  vaultKeyVersion: number;
  itemId: string;
  content: unknown;
}): Promise<EncryptedItem> {
  return buildEncryptedItem({ ...params, itemKeyVersion: 1 });
}

export interface StoredItemCiphertext {
  id: string;
  itemKeyVersion: number;
  wrappedKey: string;
  encryptedData: string;
}

/**
 * Key rotation for one item (PLAN 11.4): decrypt under the old keys, then encrypt under a fresh
 * IK' with `itemKeyVersion + 1`, wrapped under the new VK at `newVaultKeyVersion`.
 * Pass the same VK and version for old and new to rotate only the item key (item-share revoke).
 */
export async function reencryptItem(params: {
  vaultId: string;
  item: StoredItemCiphertext;
  oldVk: Uint8Array;
  oldVaultKeyVersion: number;
  newVk: Uint8Array;
  newVaultKeyVersion: number;
}): Promise<EncryptedItem> {
  const { vaultId, item, oldVk, oldVaultKeyVersion, newVk, newVaultKeyVersion } = params;
  const oldIk = await unwrapItemKey(oldVk, vaultId, item.id, oldVaultKeyVersion, item.wrappedKey);
  try {
    const content = await decryptItem(oldIk, item.id, item.itemKeyVersion, item.encryptedData);
    return await buildEncryptedItem({
      vk: newVk,
      vaultId,
      vaultKeyVersion: newVaultKeyVersion,
      itemId: item.id,
      itemKeyVersion: item.itemKeyVersion + 1,
      content,
    });
  } finally {
    oldIk.fill(0);
  }
}
