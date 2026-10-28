import { aad } from "./aad.ts";
import { utf8Decode, utf8Encode } from "./encoding.ts";
import { open, seal } from "./envelope.ts";
import { DecryptionError } from "./errors.ts";
import type { VaultMeta } from "./types.ts";

export async function encryptVaultMeta(
  vk: Uint8Array,
  vaultId: string,
  keyVersion: number,
  meta: VaultMeta,
): Promise<string> {
  return seal(vk, utf8Encode(JSON.stringify(meta)), aad.vaultMeta(vaultId, keyVersion));
}

export async function decryptVaultMeta(
  vk: Uint8Array,
  vaultId: string,
  keyVersion: number,
  encryptedMeta: string,
): Promise<VaultMeta> {
  const plaintext = await open(vk, encryptedMeta, aad.vaultMeta(vaultId, keyVersion));
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(plaintext));
  } catch (error) {
    throw new DecryptionError("Malformed vault metadata", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DecryptionError("Malformed vault metadata");
  }
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.name !== "string" ||
    (m.icon !== undefined && typeof m.icon !== "string") ||
    (m.color !== undefined && typeof m.color !== "string")
  ) {
    throw new DecryptionError("Malformed vault metadata");
  }
  const meta: VaultMeta = { name: m.name };
  if (m.icon !== undefined) meta.icon = m.icon as string;
  if (m.color !== undefined) meta.color = m.color as string;
  return meta;
}
