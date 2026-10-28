import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "./encoding.ts";
import { DecryptionError, SealedKeyMismatchError, UnsupportedVersionError } from "./errors.ts";
import { KEY_BYTES } from "./keys.ts";
import { sodiumReady } from "./sodium.ts";

export type SealedKeyType = "vault" | "item";

export interface SealedKeyReference {
  type: SealedKeyType;
  /** Vault id or item id. */
  id: string;
  /** Vault key version or item key version. */
  keyVersion: number;
}

export interface SealedKeyPayload extends SealedKeyReference {
  key: Uint8Array;
}

const PUBLIC_KEY_BYTES = 32;

function toPublicKeyBytes(publicKey: Uint8Array | string): Uint8Array {
  const bytes = typeof publicKey === "string" ? fromBase64Url(publicKey) : publicKey;
  if (bytes.length !== PUBLIC_KEY_BYTES) throw new TypeError("public key must be 32 bytes");
  return bytes;
}

/**
 * Seal a vault or item key to a recipient's X25519 public key (`crypto_box_seal`).
 * The sealed plaintext is JSON `{ v:1, type, id, keyVersion, key }` so the recipient can check it.
 */
export async function sealKey(
  recipientPublicKey: Uint8Array | string,
  payload: SealedKeyPayload,
): Promise<string> {
  const sodium = await sodiumReady();
  if (payload.key.length !== KEY_BYTES) throw new TypeError("key must be 32 bytes");
  if (payload.type !== "vault" && payload.type !== "item") throw new TypeError("invalid type");
  const json = JSON.stringify({
    v: 1,
    type: payload.type,
    id: payload.id,
    keyVersion: payload.keyVersion,
    key: toBase64Url(payload.key),
  });
  return toBase64Url(
    sodium.crypto_box_seal(utf8Encode(json), toPublicKeyBytes(recipientPublicKey)),
  );
}

/**
 * Open a sealed key and verify it is the key the record claims to carry.
 * `DecryptionError` = cannot open / malformed; `SealedKeyMismatchError` = opened but type, id or
 * keyVersion differ from `expected`.
 */
export async function openSealedKey(
  sealed: string,
  publicKey: Uint8Array | string,
  privateKey: Uint8Array,
  expected: SealedKeyReference,
): Promise<Uint8Array> {
  const sodium = await sodiumReady();
  let parsed: unknown;
  try {
    const plaintext = sodium.crypto_box_seal_open(
      fromBase64Url(sealed),
      toPublicKeyBytes(publicKey),
      privateKey,
    );
    parsed = JSON.parse(utf8Decode(plaintext));
  } catch (error) {
    throw new DecryptionError("Cannot open sealed key", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DecryptionError("Malformed sealed key payload");
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) throw new UnsupportedVersionError("Unknown sealed key payload version");
  if (p.type !== expected.type || p.id !== expected.id || p.keyVersion !== expected.keyVersion) {
    throw new SealedKeyMismatchError();
  }
  let key: Uint8Array;
  try {
    key = fromBase64Url(typeof p.key === "string" ? p.key : "");
  } catch (error) {
    throw new DecryptionError("Malformed sealed key payload", { cause: error });
  }
  if (key.length !== KEY_BYTES) throw new DecryptionError("Malformed sealed key payload");
  return key;
}
