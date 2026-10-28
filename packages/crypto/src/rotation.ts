import { type EncryptedItem, reencryptItem, type StoredItemCiphertext } from "./item.ts";
import { generateKey } from "./keys.ts";
import { decryptVaultMeta, encryptVaultMeta } from "./vault.ts";

export interface RotateVaultKeyParams {
  vaultId: string;
  oldVk: Uint8Array;
  oldKeyVersion: number;
  encryptedMeta: string;
  items: readonly StoredItemCiphertext[];
}

export interface RotatedVault {
  /** New vault key VK'. Re-seal it for every remaining member and the owner. */
  newVk: Uint8Array;
  /** `oldKeyVersion + 1`. */
  newKeyVersion: number;
  encryptedMeta: string;
  /** Same order as the input. Each carries the new IK' (re-seal it for remaining item shares). */
  items: EncryptedItem[];
}

/**
 * Vault-member revocation (PLAN 11.4): new VK' (version + 1), new IK' (version + 1) for every item,
 * metadata and contents re-encrypted. Pure over its inputs and all-or-nothing: if any item fails to
 * decrypt, it throws and returns nothing.
 */
export async function rotateVaultKey(params: RotateVaultKeyParams): Promise<RotatedVault> {
  const { vaultId, oldVk, oldKeyVersion, encryptedMeta, items } = params;
  const newVk = await generateKey();
  const newKeyVersion = oldKeyVersion + 1;
  try {
    const meta = await decryptVaultMeta(oldVk, vaultId, oldKeyVersion, encryptedMeta);
    const newMeta = await encryptVaultMeta(newVk, vaultId, newKeyVersion, meta);
    const rotated: EncryptedItem[] = [];
    for (const item of items) {
      rotated.push(
        await reencryptItem({
          vaultId,
          item,
          oldVk,
          oldVaultKeyVersion: oldKeyVersion,
          newVk,
          newVaultKeyVersion: newKeyVersion,
        }),
      );
    }
    return { newVk, newKeyVersion, encryptedMeta: newMeta, items: rotated };
  } catch (error) {
    newVk.fill(0);
    throw error;
  }
}
