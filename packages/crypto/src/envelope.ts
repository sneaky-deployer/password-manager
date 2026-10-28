import { fromBase64Url, toBase64Url, utf8Encode } from "./encoding.ts";
import { DecryptionError, InvalidEncodingError, UnsupportedVersionError } from "./errors.ts";
import { assertKey } from "./keys.ts";
import { sodiumReady } from "./sodium.ts";

/** Envelope format version byte. */
export const ENVELOPE_VERSION = 0x01;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

/**
 * Deterministic variant used only for test vectors. Never export from the package index:
 * reusing a nonce with the same key destroys XChaCha20-Poly1305's security.
 */
export async function sealWithNonce(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<string> {
  const sodium = await sodiumReady();
  assertKey("key", key);
  if (nonce.length !== NONCE_BYTES) throw new TypeError(`nonce must be ${NONCE_BYTES} bytes`);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    utf8Encode(aad),
    null,
    nonce,
    key,
  );
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return toBase64Url(out);
}

/** Encrypt `plaintext` under `key`, bound to `aad`. Returns base64url `[0x01][nonce][ct+tag]`. */
export async function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Promise<string> {
  const sodium = await sodiumReady();
  return sealWithNonce(key, sodium.randombytes_buf(NONCE_BYTES), plaintext, aad);
}

/**
 * Decrypt an envelope. Throws `UnsupportedVersionError` for an unknown version byte and
 * `DecryptionError` for anything else (malformed, wrong key, wrong AAD, tampered).
 */
export async function open(key: Uint8Array, envelope: string, aad: string): Promise<Uint8Array> {
  const sodium = await sodiumReady();
  assertKey("key", key);
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(envelope);
  } catch (error) {
    if (error instanceof InvalidEncodingError) {
      throw new DecryptionError("Malformed envelope", { cause: error });
    }
    throw error;
  }
  if (raw.length === 0) throw new DecryptionError("Malformed envelope");
  if (raw[0] !== ENVELOPE_VERSION) throw new UnsupportedVersionError("Unknown envelope version");
  if (raw.length < 1 + NONCE_BYTES + TAG_BYTES) throw new DecryptionError("Malformed envelope");
  const nonce = raw.subarray(1, 1 + NONCE_BYTES);
  const ct = raw.subarray(1 + NONCE_BYTES);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, utf8Encode(aad), nonce, key);
  } catch (error) {
    throw new DecryptionError("Decryption failed", { cause: error });
  }
}
