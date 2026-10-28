// Login 2FA (PLAN.md 10.6): TOTP with replay protection, single-use backup codes and the
// short-lived `auth_challenges` used by the two-step login, recovery and passkey registration.
import { BACKUP_CODE_COUNT, type TwoFactorMethod } from "@pm/shared";
import { and, count, eq, isNull, lt, or } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import type { Db } from "../../db/client.ts";
import {
  type AuthChallenge,
  type AuthChallengeKind,
  authChallenges,
  backupCodes,
  type User,
  users,
  webauthnCredentials,
} from "../../db/schema.ts";
import type { Config } from "../../env.ts";
import {
  aesGcmDecryptToString,
  aesGcmEncrypt,
  newId,
  randomBytes,
  randomToken,
  sha256Hex,
} from "../crypto.ts";

// --- TOTP ---------------------------------------------------------------------------------------

const TOTP_PARAMS = { algorithm: "SHA1", digits: 6, period: 30 } as const;
export const TOTP_ISSUER = "Password Manager";
/** Accept the current 30 s step and one step either side (clock drift). */
const TOTP_WINDOW = 1;

/** AAD binds a stored TOTP secret to its owner, so a copied value is useless on another row. */
export function totpAad(userId: string): string {
  return `pm:totp:${userId}`;
}

export async function encryptTotpSecret(
  config: Config,
  userId: string,
  base32: string,
): Promise<string> {
  return aesGcmEncrypt(config.serverEncKey, base32, totpAad(userId));
}

export async function decryptTotpSecret(
  config: Config,
  userId: string,
  encrypted: string,
): Promise<string> {
  return aesGcmDecryptToString(config.serverEncKey, encrypted, totpAad(userId));
}

/** New random 160-bit secret as unpadded base32 (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ buffer: randomBytes(20).buffer }).base32;
}

export function totpUri(email: string, base32: string): string {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: email,
    secret: OTPAuth.Secret.fromBase32(base32),
    ...TOTP_PARAMS,
  }).toString();
}

/** The 30 s step number the code belongs to (current step +/- 1), or null when it is wrong. */
export function matchTotpStep(base32: string, code: string, now = Date.now()): number | null {
  const delta = OTPAuth.TOTP.validate({
    token: code,
    secret: OTPAuth.Secret.fromBase32(base32),
    ...TOTP_PARAMS,
    timestamp: now,
    window: TOTP_WINDOW,
  });
  if (delta === null) return null;
  return OTPAuth.TOTP.counter({ period: TOTP_PARAMS.period, timestamp: now }) + delta;
}

/**
 * Verifies a login TOTP code against the user's stored secret and records the step so the same
 * code (or an older one) cannot be used twice. The step update is one conditional statement, so
 * two simultaneous requests with the same code cannot both succeed.
 */
export async function verifyUserTotp(
  db: Db,
  config: Config,
  user: Pick<User, "id" | "totpSecretEnc">,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  if (!user.totpSecretEnc) return false;
  const base32 = await decryptTotpSecret(config, user.id, user.totpSecretEnc);
  const step = matchTotpStep(base32, code, now);
  if (step === null) return false;
  const rows = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .returning({ id: users.id });
  return rows.length > 0;
}

// --- Backup codes -------------------------------------------------------------------------------

// 32 symbols (no 0/1/l/o lookalikes), so one random byte masked to 5 bits is unbiased.
const BACKUP_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

/** `xxxx-xxxx`, 40 bits. Single use and rate limited, so that is plenty. */
export function generateBackupCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += BACKUP_ALPHABET[(bytes[i] as number) & 31];
    if (i === 3) out += "-";
  }
  return out;
}

/** Dashes, case and surrounding spaces do not matter when entering a code. */
export function normalizeBackupCode(code: string): string {
  return code.trim().toLowerCase().replaceAll("-", "");
}

export function hashBackupCode(code: string): Promise<string> {
  return sha256Hex(`backup:${normalizeBackupCode(code)}`);
}

/**
 * Fresh set of backup codes: the plaintext codes (to show once) and the statements that replace
 * every existing code with the new ones, for `db.batch`.
 */
export async function buildBackupCodeSet(db: Db, userId: string) {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  const rows = await Promise.all(
    codes.map(async (code) => ({
      id: newId(),
      userId,
      codeHash: await hashBackupCode(code),
      usedAt: null,
    })),
  );
  return {
    codes,
    deleteOld: db.delete(backupCodes).where(eq(backupCodes.userId, userId)),
    insertNew: db.insert(backupCodes).values(rows),
  };
}

/** Uses up one backup code. True only if it existed and was unused (atomic). */
export async function consumeBackupCode(
  db: Db,
  userId: string,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(backupCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(backupCodes.userId, userId),
        eq(backupCodes.codeHash, await hashBackupCode(code)),
        isNull(backupCodes.usedAt),
      ),
    )
    .returning({ id: backupCodes.id });
  return rows.length > 0;
}

// --- State --------------------------------------------------------------------------------------

export interface TwoFactorState {
  totp: boolean;
  passkeys: number;
  backupCodes: number;
  /** TOTP enabled or at least one passkey: signing in needs a second factor. */
  enabled: boolean;
  methods: TwoFactorMethod[];
}

/** One round trip: passkey count and unused backup code count. */
export async function loadTwoFactorState(
  db: Db,
  user: Pick<User, "id" | "totpSecretEnc">,
): Promise<TwoFactorState> {
  const [passkeyRows, backupRows] = await db.batch([
    db
      .select({ n: count() })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id)),
    db
      .select({ n: count() })
      .from(backupCodes)
      .where(and(eq(backupCodes.userId, user.id), isNull(backupCodes.usedAt))),
  ]);
  const passkeys = passkeyRows[0]?.n ?? 0;
  const unusedBackup = backupRows[0]?.n ?? 0;
  const totp = user.totpSecretEnc !== null;
  const methods: TwoFactorMethod[] = [];
  if (totp) methods.push("totp");
  if (passkeys > 0) methods.push("webauthn");
  if (unusedBackup > 0 && (totp || passkeys > 0)) methods.push("backup_code");
  return { totp, passkeys, backupCodes: unusedBackup, enabled: totp || passkeys > 0, methods };
}

// --- Challenges ---------------------------------------------------------------------------------

export const LOGIN_CHALLENGE_PURPOSE = "login";
export const TOTP_SETUP_PURPOSE = "totp_setup";

export interface ChallengeInsert {
  token: string;
  tokenHash: string;
  row: AuthChallenge;
}

/** A random-token challenge (login 2FA, recovery). The token goes to the client, the hash to the DB. */
export async function buildChallenge(
  userId: string,
  kind: AuthChallengeKind,
  payload: Record<string, unknown>,
  ttlMs: number,
  now = Date.now(),
): Promise<ChallengeInsert> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  return {
    token,
    tokenHash,
    row: {
      id: newId(),
      userId,
      kind,
      tokenHash,
      payload: JSON.stringify(payload),
      expiresAt: now + ttlMs,
    },
  };
}

/**
 * A per-user singleton challenge (pending TOTP secret, pending passkey registration). The token
 * hash is derived from the user id, never handed to a client, so there is at most one row per
 * (kind, user) and the owner finds it without a token.
 */
export async function singletonChallengeHash(kind: AuthChallengeKind, userId: string) {
  return sha256Hex(`singleton:${kind}:${userId}`);
}

export async function buildSingletonChallenge(
  userId: string,
  kind: AuthChallengeKind,
  payload: Record<string, unknown>,
  ttlMs: number,
  now = Date.now(),
): Promise<AuthChallenge> {
  return {
    id: newId(),
    userId,
    kind,
    tokenHash: await singletonChallengeHash(kind, userId),
    payload: JSON.stringify(payload),
    expiresAt: now + ttlMs,
  };
}

/** The live challenge of `kind` for a client-held token, or null. */
export async function findChallengeByToken(
  db: Db,
  kind: AuthChallengeKind,
  token: string,
  now = Date.now(),
): Promise<AuthChallenge | null> {
  const row = await db
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.tokenHash, await sha256Hex(token)), eq(authChallenges.kind, kind)))
    .get();
  if (!row || row.expiresAt <= now) return null;
  return row;
}

export async function findSingletonChallenge(
  db: Db,
  kind: AuthChallengeKind,
  userId: string,
  now = Date.now(),
): Promise<AuthChallenge | null> {
  const row = await db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.tokenHash, await singletonChallengeHash(kind, userId)))
    .get();
  if (!row || row.kind !== kind || row.expiresAt <= now) return null;
  return row;
}

export function parsePayload(row: Pick<AuthChallenge, "payload">): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.payload);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Deletes a challenge and reports whether this call removed it (single use, atomic). */
export async function takeChallenge(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(authChallenges)
    .where(eq(authChallenges.id, id))
    .returning({ id: authChallenges.id });
  return rows.length > 0;
}
