import { sodiumReady } from "./sodium.ts";

export const KEY_BYTES = 32;

/** Fresh random 32-byte symmetric key (AK, VK, IK). */
export async function generateKey(): Promise<Uint8Array> {
  const sodium = await sodiumReady();
  return sodium.randombytes_buf(KEY_BYTES);
}

export function assertKey(name: string, key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new TypeError(`${name} must be a ${KEY_BYTES}-byte Uint8Array`);
  }
}
