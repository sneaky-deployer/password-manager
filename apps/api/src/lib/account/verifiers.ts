// Password and recovery verifiers (PLAN.md 9.5, 10.2) and the wire shapes built from a user row.
// The server never hashes passwords: the client sends a 256-bit derived `authKey`, and the server
// keeps/compares `HMAC-SHA256(AUTH_PEPPER, authKey)` (a fast keyed hash fits the 10 ms CPU limit).
import {
  DEFAULT_USER_SETTINGS,
  type KeyBundle,
  type MeSummary,
  userSettingsSchema,
} from "@pm/shared";
import { count, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { type User, webauthnCredentials } from "../../db/schema.ts";
import type { Config } from "../../env.ts";
import { base64urlDecode, hmacSha256Hex, tryBase64urlDecode, verifyHmac } from "../crypto.ts";

/** `HMAC-SHA256(AUTH_PEPPER, authKey)` as hex; works for authKey and recoveryAuthKey alike. */
export async function computeVerifier(config: Config, key: string): Promise<string> {
  return hmacSha256Hex(config.authPepper, base64urlDecode(key));
}

/** Constant-time check of a client-supplied key against a stored verifier. */
export async function checkVerifier(
  config: Config,
  key: string,
  expectedHex: string,
): Promise<boolean> {
  const bytes = tryBase64urlDecode(key);
  if (!bytes) return false;
  return verifyHmac(config.authPepper, bytes, expectedHex);
}

const DUMMY_VERIFIER = "0".repeat(64);

/** Does the same work as a real check, so unknown emails cost the same time as wrong keys. */
export async function checkDummyVerifier(config: Config, key: string): Promise<false> {
  await checkVerifier(config, key, DUMMY_VERIFIER);
  return false;
}

/** Stored settings JSON merged over the defaults; malformed or out-of-range values fall back. */
export function parseSettings(raw: string): MeSummary["settings"] {
  let value: unknown = {};
  try {
    value = JSON.parse(raw);
  } catch {
    // fall through to the defaults
  }
  const merged = {
    ...DEFAULT_USER_SETTINGS,
    ...(typeof value === "object" && value !== null ? value : {}),
  };
  const result = userSettingsSchema.safeParse(merged);
  return result.success ? result.data : { ...DEFAULT_USER_SETTINGS };
}

export async function countPasskeys(db: Db, userId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .get();
  return row?.n ?? 0;
}

/** The profile summary. Never includes verifiers or key material. */
export function toMeSummary(user: User, passkeyCount: number): MeSummary {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    twoFactor: { totp: user.totpSecretEnc !== null, webauthn: passkeyCount },
    settings: parseSettings(user.settings),
  };
}

/** What a client needs to unlock (response of `GET /me/keys` and part of the login response). */
export function toKeyBundle(user: User): KeyBundle {
  return {
    userId: user.id,
    kdf: { alg: "argon2id13", mem: user.kdfMem, ops: user.kdfOps },
    salt: user.kdfSalt,
    wrappedAkPw: user.wrappedAkPw,
    publicKey: user.publicKey,
    encryptedPrivateKey: user.encryptedPrivateKey,
    keyGeneration: user.keyGeneration,
  };
}
