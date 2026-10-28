// Helpers for the account route tests (setup, invites, login, 2FA, recovery, me, admin).
import { env } from "cloudflare:workers";
import {
  type AccountCreation,
  apiPaths,
  backupCodesResponseSchema,
  loginOkResponseSchema,
  type MeSummary,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from "@pm/shared";
import * as OTPAuth from "otpauth";
import type { User } from "../src/db/schema.ts";
import { getConfig } from "../src/env.ts";
import { computeVerifier } from "../src/lib/account/verifiers.ts";
import { newId, sha256Hex } from "../src/lib/crypto.ts";
import { getDevOutbox } from "../src/lib/email.ts";
import { createClient, createUser, fakeBlob, readJson, type TestClient } from "./helpers.ts";

export const config = () => getConfig(env);

/** Fresh random key material shaped like what the browser sends (sizes and encodings are valid). */
export function accountMaterial(overrides: { authKey?: string; recoveryAuthKey?: string } = {}) {
  const material: AccountCreation = {
    user: {
      id: newId(),
      kdf: { alg: "argon2id13", mem: 64 * 1024 * 1024, ops: 3 },
      salt: fakeBlob(16),
      authKey: overrides.authKey ?? fakeBlob(32),
      wrappedAkPw: fakeBlob(72),
      wrappedAkRec: fakeBlob(72),
      recoveryAuthKey: overrides.recoveryAuthKey ?? fakeBlob(32),
      publicKey: fakeBlob(32),
      encryptedPrivateKey: fakeBlob(72),
    },
    vault: {
      id: newId(),
      keyVersion: 1,
      encryptedMeta: fakeBlob(48),
      sealedKey: fakeBlob(80),
    },
  };
  return material;
}

/** New password material for password change / recovery / reset-from-unlocked / KDF upgrade. */
export function passwordMaterial(overrides: { newAuthKey?: string } = {}) {
  return {
    newSalt: fakeBlob(16),
    newKdf: { alg: "argon2id13" as const, mem: 64 * 1024 * 1024, ops: 3 },
    newAuthKey: overrides.newAuthKey ?? fakeBlob(32),
    newWrappedAk: fakeBlob(72),
  };
}

export interface KnownUser {
  user: User;
  authKey: string;
  recoveryAuthKey: string;
}

/** Inserts a user whose verifiers match known keys, so tests can log in through the API. */
export async function createKnownUser(overrides: Partial<User> = {}): Promise<KnownUser> {
  const authKey = fakeBlob(32);
  const recoveryAuthKey = fakeBlob(32);
  const user = await createUser({
    authVerifier: await computeVerifier(config(), authKey),
    recoveryVerifier: await computeVerifier(config(), recoveryAuthKey),
    ...overrides,
  });
  return { user, authKey, recoveryAuthKey };
}

/** Logs in through `POST /auth/login` and returns the client with its session cookie. */
export async function loginAs(known: KnownUser, client: TestClient = createClient()) {
  const res = await client.post(apiPaths.auth.login, {
    email: known.user.email,
    authKey: known.authKey,
  });
  if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
  const body = loginOkResponseSchema.parse(await readJson(res));
  return { client, body };
}

export function profileOf(body: { user: MeSummary }) {
  return body.user;
}

// --- Emails -------------------------------------------------------------------------------------

export function emailsTo(address: string) {
  return getDevOutbox().filter((message) => message.to === address);
}

/** The 6 digit code in the newest email to `address`. */
export function latestCode(address: string): string {
  const messages = emailsTo(address);
  const text = messages[messages.length - 1]?.text ?? "";
  const match = text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code email for ${address}`);
  return match[1];
}

/** The invite token in the newest email to `address` (link `.../invite#t=<token>`). */
export function latestInviteToken(address: string): string {
  const messages = emailsTo(address);
  const text = messages[messages.length - 1]?.text ?? "";
  const match = text.match(/\/invite#t=([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error(`no invite email for ${address}`);
  return match[1];
}

export const hashToken = (token: string) => sha256Hex(token);

// --- TOTP ---------------------------------------------------------------------------------------

export function totpCode(base32: string, timestamp = Date.now()): string {
  return OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(base32),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    timestamp,
  });
}

/** Sets up and enables TOTP for a signed-in client. Returns the base32 secret and backup codes. */
export async function enableTotp(client: TestClient) {
  const setupRes = await client.post(apiPaths.me.totpSetup);
  if (setupRes.status !== 200) throw new Error(`totp setup failed with ${setupRes.status}`);
  const { secret } = totpSetupResponseSchema.parse(await readJson(setupRes));
  const enableRes = await client.post(apiPaths.me.totpEnable, { code: totpCode(secret) });
  if (enableRes.status !== 200) throw new Error(`totp enable failed with ${enableRes.status}`);
  const { backupCodes } = totpEnableResponseSchema.parse(await readJson(enableRes));
  return { secret, backupCodes };
}

export async function regenerateBackupCodes(client: TestClient) {
  const res = await client.post(apiPaths.me.backupCodes);
  return backupCodesResponseSchema.parse(await readJson(res)).backupCodes;
}
