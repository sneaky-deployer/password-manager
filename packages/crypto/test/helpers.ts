import { type KdfParams, MIN_KDF_MEM, MIN_KDF_OPS } from "../src/index.ts";

/** Weakest accepted parameters, so flow tests stay fast. */
export const FAST_KDF: KdfParams = { alg: "argon2id13", mem: MIN_KDF_MEM, ops: MIN_KDF_OPS };

export const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const V1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const V2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const I1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const I2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/** Flip one bit of a base64url envelope's decoded bytes. */
export function flipBit(b64: string, byteIndex: number): string {
  const bytes = Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  bytes[byteIndex] = (bytes[byteIndex] ?? 0) ^ 1;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
