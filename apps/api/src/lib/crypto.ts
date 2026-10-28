// Server-side crypto helpers (WebCrypto only). These are the only crypto calls allowed in
// apps/api (PLAN.md section 21 rule 2) and they never touch vault data: HMAC verifiers, hashing
// tokens, and AES-GCM for login TOTP secrets. Password hashing does NOT happen here (10 ms CPU).
// Everything is one-shot and tiny so a request stays far below the Workers free-plan CPU limit.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Bytes = Uint8Array<ArrayBuffer>;
export type BinaryLike = string | Uint8Array;

/** Strings are UTF-8 encoded; byte arrays pass through. */
export function toBytes(data: BinaryLike): Bytes {
  const source = typeof data === "string" ? encoder.encode(data) : data;
  // Copy, so WebCrypto always sees a plain ArrayBuffer-backed array (never a shared view).
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy;
}

// ---------------------------------------------------------------------------------------------
// base64url (RFC 4648 section 5, no padding) and hex
// ---------------------------------------------------------------------------------------------

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function base64urlEncode(data: BinaryLike): string {
  const bytes = toBytes(data);
  let binary = "";
  // Chunked so large ciphertexts do not overflow the argument limit of fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Strict decode: throws on any character outside the base64url alphabet (including padding). */
export function base64urlDecode(value: string): Bytes {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid base64url");
  }
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Non-throwing variant for untrusted input. */
export function tryBase64urlDecode(value: string): Bytes | null {
  try {
    return base64urlDecode(value);
  } catch {
    return null;
  }
}

export function hexEncode(data: BinaryLike): string {
  let out = "";
  for (const byte of toBytes(data)) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexDecode(value: string): Bytes | null {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Hashing, HMAC, randomness
// ---------------------------------------------------------------------------------------------

export async function sha256(data: BinaryLike): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(data)));
}

/** Lowercase hex SHA-256. Used for token hashes (sessions, invites, challenges). */
export async function sha256Hex(data: BinaryLike): Promise<string> {
  return hexEncode(await sha256(data));
}

function importHmacKey(keyBytes: Uint8Array, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toBytes(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function hmacSha256(keyBytes: Uint8Array, data: BinaryLike): Promise<Bytes> {
  const key = await importHmacKey(keyBytes, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(data)));
}

/** HMAC-SHA256 as lowercase hex (the `auth_verifier` / `recovery_verifier` format). */
export async function hmacSha256Hex(keyBytes: Uint8Array, data: BinaryLike): Promise<string> {
  return hexEncode(await hmacSha256(keyBytes, data));
}

/**
 * Constant-time check of `expectedHex` against HMAC-SHA256(key, data). Uses WebCrypto's own
 * `verify`, which compares in constant time. Malformed hex returns false.
 */
export async function verifyHmac(
  keyBytes: Uint8Array,
  data: BinaryLike,
  expectedHex: string,
): Promise<boolean> {
  const expected = hexDecode(expectedHex);
  if (expected?.length !== 32) return false;
  const key = await importHmacKey(keyBytes, ["verify"]);
  return crypto.subtle.verify("HMAC", key, expected, toBytes(data));
}

/** Constant-time equality for two equal-purpose secrets (hashes, codes). */
export function constantTimeEqual(a: BinaryLike, b: BinaryLike): boolean {
  const x = toBytes(a);
  const y = toBytes(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Random token, base64url. Default 32 bytes (43 characters). */
export function randomToken(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes));
}

/** UUID v4 for server-generated IDs. */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Uniform random numeric code of `digits` digits (e.g. email codes), by rejection sampling so
 * there is no modulo bias.
 */
export function randomDigits(digits: number): string {
  const limit = 10 ** digits;
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < ceiling) return String(value % limit).padStart(digits, "0");
  }
}

// ---------------------------------------------------------------------------------------------
// AES-256-GCM for server-held secrets (login TOTP). Format: base64url(iv(12) || ciphertext+tag)
// ---------------------------------------------------------------------------------------------

const IV_LENGTH = 12;

function aesParams(iv: Uint8Array, aad: BinaryLike | undefined) {
  return aad === undefined
    ? { name: "AES-GCM", iv }
    : { name: "AES-GCM", iv, additionalData: toBytes(aad) };
}

function importAesKey(keyBytes: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (keyBytes.length !== 32) throw new TypeError("AES-256-GCM needs a 32-byte key");
  return crypto.subtle.importKey("raw", toBytes(keyBytes), "AES-GCM", false, [usage]);
}

/** `aad` binds the ciphertext to its owner (e.g. the user id); pass the same value to decrypt. */
export async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: BinaryLike,
  aad?: BinaryLike,
): Promise<string> {
  const key = await importAesKey(keyBytes, "encrypt");
  const iv = randomBytes(IV_LENGTH);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(aesParams(iv, aad), key, toBytes(plaintext)),
  );
  const out = new Uint8Array(IV_LENGTH + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, IV_LENGTH);
  return base64urlEncode(out);
}

/** Returns the plaintext bytes; throws if the key, AAD or data is wrong or tampered with. */
export async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  encoded: string,
  aad?: BinaryLike,
): Promise<Bytes> {
  const key = await importAesKey(keyBytes, "decrypt");
  const data = base64urlDecode(encoded);
  if (data.length < IV_LENGTH + 16) throw new TypeError("Ciphertext too short");
  const iv = data.subarray(0, IV_LENGTH);
  return new Uint8Array(
    await crypto.subtle.decrypt(aesParams(iv, aad), key, data.subarray(IV_LENGTH)),
  );
}

export async function aesGcmDecryptToString(
  keyBytes: Uint8Array,
  encoded: string,
  aad?: BinaryLike,
): Promise<string> {
  return decoder.decode(await aesGcmDecrypt(keyBytes, encoded, aad));
}

// ---------------------------------------------------------------------------------------------
// Prelogin fake salt (PLAN.md 10.2)
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic 16-byte salt for emails without an account, so `prelogin` looks identical for
 * known and unknown emails. The email is trimmed and lowercased first.
 */
export async function fakeSalt(fakeSaltKey: Uint8Array, email: string): Promise<string> {
  const mac = await hmacSha256(fakeSaltKey, email.trim().toLowerCase());
  return base64urlEncode(mac.subarray(0, 16));
}
