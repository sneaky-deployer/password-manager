import { fromBase64Url, utf8Encode } from "./encoding.ts";
import { InvalidKdfParamsError } from "./errors.ts";
import { memzero } from "./memzero.ts";
import { sodiumReady } from "./sodium.ts";

export interface KdfParams {
  alg: "argon2id13";
  /** Argon2id memory in bytes. */
  mem: number;
  /** Argon2id passes (opslimit). */
  ops: number;
}

export const DEFAULT_KDF: KdfParams = Object.freeze({
  alg: "argon2id13",
  mem: 67_108_864,
  ops: 3,
});

/** Refuse anything weaker, so a malicious server can't downgrade the KDF. */
export const MIN_KDF_MEM = 16 * 1024 * 1024;
export const MIN_KDF_OPS = 2;
/** Upper bounds stop a malicious server from making the client exhaust memory or hang. */
export const MAX_KDF_MEM = 1024 * 1024 * 1024;
export const MAX_KDF_OPS = 16;

export const PASSWORD_KDF_CONTEXT = "PMKEYS01";
export const AUTH_KEY_SUBKEY_ID = 1;
export const WRAP_KEY_SUBKEY_ID = 2;
export const SALT_BYTES = 16;

/** Throws `InvalidKdfParamsError` unless `kdf` is argon2id13 within [minimum, maximum]. */
export function validateKdfParams(kdf: unknown): asserts kdf is KdfParams {
  if (typeof kdf !== "object" || kdf === null) throw new InvalidKdfParamsError();
  const { alg, mem, ops } = kdf as Record<string, unknown>;
  if (alg !== "argon2id13") throw new InvalidKdfParamsError("Unsupported KDF algorithm");
  if (typeof mem !== "number" || !Number.isSafeInteger(mem)) {
    throw new InvalidKdfParamsError("KDF memory must be an integer");
  }
  if (typeof ops !== "number" || !Number.isSafeInteger(ops)) {
    throw new InvalidKdfParamsError("KDF ops must be an integer");
  }
  if (mem < MIN_KDF_MEM) throw new InvalidKdfParamsError("KDF memory is below the minimum");
  if (ops < MIN_KDF_OPS) throw new InvalidKdfParamsError("KDF ops is below the minimum");
  if (mem > MAX_KDF_MEM) throw new InvalidKdfParamsError("KDF memory is above the maximum");
  if (ops > MAX_KDF_OPS) throw new InvalidKdfParamsError("KDF ops is above the maximum");
}

/** True when the stored params are weaker than the current defaults (PLAN 9.1: silently re-wrap). */
export function kdfNeedsUpgrade(kdf: KdfParams): boolean {
  return kdf.mem < DEFAULT_KDF.mem || kdf.ops < DEFAULT_KDF.ops;
}

/** Derive a 32-byte subkey with `crypto_kdf_derive_from_key` (8-char context). */
export async function deriveSubkey(
  masterKey: Uint8Array,
  id: number,
  context: string,
): Promise<Uint8Array> {
  const sodium = await sodiumReady();
  return sodium.crypto_kdf_derive_from_key(32, id, context, masterKey);
}

export interface PasswordKeys {
  /** Sent to the server at login; the server stores only an HMAC of it. */
  authKey: Uint8Array;
  /** Encrypts the account key; never leaves the client. */
  wrapKey: Uint8Array;
}

/** Argon2id(password, salt) -> PMKEYS01 subkeys 1 (authKey) and 2 (wrapKey). CPU/memory heavy. */
export async function derivePasswordKeys(
  password: string,
  saltB64: string,
  kdf: KdfParams,
): Promise<PasswordKeys> {
  validateKdfParams(kdf);
  const sodium = await sodiumReady();
  const salt = fromBase64Url(saltB64);
  if (salt.length !== SALT_BYTES) throw new TypeError(`salt must be ${SALT_BYTES} bytes`);
  // NFKC so the same password typed on different OSes/keyboards derives the same key.
  const passwordBytes = utf8Encode(password.normalize("NFKC"));
  const passwordKey = sodium.crypto_pwhash(
    32,
    passwordBytes,
    salt,
    kdf.ops,
    kdf.mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return {
      authKey: await deriveSubkey(passwordKey, AUTH_KEY_SUBKEY_ID, PASSWORD_KDF_CONTEXT),
      wrapKey: await deriveSubkey(passwordKey, WRAP_KEY_SUBKEY_ID, PASSWORD_KDF_CONTEXT),
    };
  } finally {
    memzero(passwordKey);
    memzero(passwordBytes);
  }
}
