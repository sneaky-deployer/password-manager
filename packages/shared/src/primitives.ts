import { z } from "zod";
import {
  ENVELOPE_OVERHEAD_BYTES,
  KDF_MAXIMUMS,
  KDF_MINIMUMS,
  MAX_ENCRYPTED_DATA_CHARS,
  MAX_META_ENVELOPE_CHARS,
  MAX_SMALL_ENVELOPE_CHARS,
} from "./constants.ts";

/** Length of the unpadded base64url encoding of `n` bytes (32 -> 43, 16 -> 22, 24 -> 32). */
export function base64urlLength(n: number): number {
  return Math.ceil((n * 4) / 3);
}

/** Base64url without padding. A length of 1 mod 4 can never be a valid encoding. */
export const base64urlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Expected base64url without padding")
  .refine((value) => value.length % 4 !== 1, "Invalid base64url length");

/** Base64url string that decodes to exactly `n` bytes, e.g. `base64urlBytes(32)` has 43 chars. */
export function base64urlBytes(n: number) {
  return base64urlSchema.refine(
    (value) => value.length === base64urlLength(n),
    `Expected ${n} bytes encoded as base64url (${base64urlLength(n)} characters)`,
  );
}

/** 32 random bytes: auth keys, public keys, tokens, sealed key material. */
export const bytes32Schema = base64urlBytes(32);
/** 16 random bytes: KDF salt. */
export const salt16Schema = base64urlBytes(16);

/** Opaque random token (invite, challenge, recovery): 32 bytes, base64url. */
export const tokenSchema = bytes32Schema;

const UUID_V4_LOWERCASE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** UUID v4, lowercase (IDs are embedded in AAD strings, so the spelling must be canonical). */
export const uuidSchema = z.string().regex(UUID_V4_LOWERCASE, "Expected a lowercase UUID v4");

/** Email: trimmed, lowercased, at most 254 characters. */
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Unix milliseconds. */
export const timestampSchema = z.int().nonnegative();

/** Positive integer version/revision counters. */
export const versionSchema = z.int().min(1);

/** Argon2id parameters (PLAN.md 9.1); `mem` is in bytes. */
export const kdfParamsSchema = z.strictObject({
  alg: z.literal("argon2id13"),
  mem: z.int().min(KDF_MINIMUMS.mem).max(KDF_MAXIMUMS.mem),
  ops: z.int().min(KDF_MINIMUMS.ops).max(KDF_MAXIMUMS.ops),
});
export type KdfParams = z.infer<typeof kdfParamsSchema>;

/** Smallest valid envelope: 1 version byte + 24 nonce + 16 tag = 41 bytes -> 55 base64url chars. */
export const MIN_ENVELOPE_CHARS = base64urlLength(ENVELOPE_OVERHEAD_BYTES);

/**
 * Symmetric ciphertext envelope `base64url([0x01][nonce 24][ciphertext + tag 16])` (PLAN.md 9.3).
 * Only the shape is checked here; authenticity is checked by decrypting.
 */
export const envelopeSchema = base64urlSchema.min(MIN_ENVELOPE_CHARS).max(MAX_ENCRYPTED_DATA_CHARS);

/** Envelope around a 32-byte key or similarly small payload (wrapped AK, IK, private key). */
export const smallEnvelopeSchema = base64urlSchema
  .min(MIN_ENVELOPE_CHARS)
  .max(MAX_SMALL_ENVELOPE_CHARS);

/** Envelope around vault metadata `{ name, icon?, color? }`. */
export const metaEnvelopeSchema = base64urlSchema
  .min(MIN_ENVELOPE_CHARS)
  .max(MAX_META_ENVELOPE_CHARS);

/**
 * libsodium sealed box (`crypto_box_seal`): 32 byte ephemeral key + 16 byte MAC + the JSON
 * payload from PLAN.md 9.3 (about 130 bytes). Minimum is 49 bytes (64 chars), maximum is lenient.
 */
export const sealedBoxSchema = base64urlSchema.min(64).max(1024);

/** Six digits, as shown in an authenticator app. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/, "Expected a 6 digit code");

/** Backup code: shown to the user as `xxxx-xxxx` style text; the server picks the format. */
export const backupCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(8)
  .max(32)
  .regex(/^[a-z0-9-]+$/);

/** Code sent by email (recovery, reset, sensitive actions). */
export const emailCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Expected a 6 digit code");

/** Generic acknowledgement for endpoints with nothing to return. */
export const okResponseSchema = z.strictObject({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/**
 * Request body for endpoints that take none. Servers should treat a missing/empty body as `{}`
 * before parsing with this schema.
 */
export const emptyRequestSchema = z.strictObject({});
export type EmptyRequest = z.infer<typeof emptyRequestSchema>;

/** Path parameter `:id`. */
export const idParamsSchema = z.strictObject({ id: uuidSchema });
export type IdParams = z.infer<typeof idParamsSchema>;
