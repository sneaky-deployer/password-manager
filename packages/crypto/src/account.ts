import { aad } from "./aad.ts";
import { constantTimeEqual, fromBase64Url, toBase64Url } from "./encoding.ts";
import { open, seal } from "./envelope.ts";
import { DecryptionError, InvalidRecoveryPhraseError, WrongPasswordError } from "./errors.ts";
import type { KdfParams } from "./kdf.ts";
import { DEFAULT_KDF, derivePasswordKeys, SALT_BYTES, validateKdfParams } from "./kdf.ts";
import { generateKey, KEY_BYTES } from "./keys.ts";
import { memzero, wipe } from "./memzero.ts";
import {
  deriveRecoveryKeys,
  deriveRecoveryKeysFromPhrase,
  generateRecoveryPhrase,
  parseRecoveryPhrase,
  recoveryAuthKeyFromPhrase,
} from "./recovery.ts";
import { sealKey } from "./sealed.ts";
import { sodiumReady } from "./sodium.ts";
import type {
  AccountCreation,
  KeyBundle,
  PasswordChangeMaterial,
  RecoveryKitReplace,
} from "./types.ts";
import { encryptVaultMeta } from "./vault.ts";

export { recoveryAuthKeyFromPhrase };

export interface AccountKeys {
  accountKey: Uint8Array;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface CreatedAccount {
  creation: AccountCreation;
  /** 24 words. Show once, never send to the server. */
  recoveryPhrase: string;
  keys: AccountKeys & { vaultKey: Uint8Array };
}

async function randomSalt(): Promise<Uint8Array> {
  const sodium = await sodiumReady();
  return sodium.randombytes_buf(SALT_BYTES);
}

/** Everything the client builds locally when accepting an invite (PLAN 10.1 step 4). */
export async function createAccount(params: {
  password: string;
  userId: string;
  vaultId: string;
  vaultName: string;
  kdf?: KdfParams;
}): Promise<CreatedAccount> {
  const { password, userId, vaultId, vaultName } = params;
  const kdf = params.kdf ?? DEFAULT_KDF;
  validateKdfParams(kdf);
  const sodium = await sodiumReady();

  const salt = toBase64Url(await randomSalt());
  const { authKey, wrapKey } = await derivePasswordKeys(password, salt, kdf);

  const accountKey = await generateKey();
  const keypair = sodium.crypto_box_keypair();
  const encryptedPrivateKey = await seal(accountKey, keypair.privateKey, aad.privateKey(userId));
  const wrappedAkPw = await seal(wrapKey, accountKey, aad.akPw(userId));

  const recoveryPhrase = await generateRecoveryPhrase();
  const recovery = await deriveRecoveryKeysFromPhrase(recoveryPhrase);
  const wrappedAkRec = await seal(recovery.recoveryWrapKey, accountKey, aad.akRec(userId));

  const vaultKey = await generateKey();
  const encryptedMeta = await encryptVaultMeta(vaultKey, vaultId, 1, { name: vaultName });
  const sealedKey = await sealKey(keypair.publicKey, {
    type: "vault",
    id: vaultId,
    keyVersion: 1,
    key: vaultKey,
  });

  const creation: AccountCreation = {
    user: {
      id: userId,
      kdf: { alg: kdf.alg, mem: kdf.mem, ops: kdf.ops },
      salt,
      authKey: toBase64Url(authKey),
      wrappedAkPw,
      wrappedAkRec,
      recoveryAuthKey: toBase64Url(recovery.recoveryAuthKey),
      publicKey: toBase64Url(keypair.publicKey),
      encryptedPrivateKey,
    },
    vault: { id: vaultId, keyVersion: 1, encryptedMeta, sealedKey },
  };
  wipe(authKey, wrapKey, recovery.recoveryAuthKey, recovery.recoveryWrapKey);
  return {
    creation,
    recoveryPhrase,
    keys: { accountKey, publicKey: keypair.publicKey, privateKey: keypair.privateKey, vaultKey },
  };
}

/** Argon2id once, for login: authKey to send, wrapKey to keep for the unlock that follows. */
export async function deriveLoginKeys(
  password: string,
  salt: string,
  kdf: KdfParams,
): Promise<{ authKey: string; wrapKey: Uint8Array }> {
  const keys = await derivePasswordKeys(password, salt, kdf);
  const authKey = toBase64Url(keys.authKey);
  memzero(keys.authKey);
  return { authKey, wrapKey: keys.wrapKey };
}

/** base64url authKey for `POST /auth/login`. Use `deriveLoginKeys` to avoid a second Argon2 run. */
export async function deriveAuthKeyForLogin(
  password: string,
  salt: string,
  kdf: KdfParams,
): Promise<string> {
  const { authKey, wrapKey } = await deriveLoginKeys(password, salt, kdf);
  memzero(wrapKey);
  return authKey;
}

/**
 * Unlock with an already derived wrapKey (from `deriveLoginKeys`). Wrong key ->
 * `WrongPasswordError`. A bundle whose public key does not match the decrypted private key
 * (e.g. swapped by a malicious server) -> `DecryptionError`. Does not wipe `wrapKey`.
 */
export async function unlockAccountWithWrapKey(
  wrapKey: Uint8Array,
  bundle: KeyBundle,
): Promise<AccountKeys> {
  const sodium = await sodiumReady();
  let accountKey: Uint8Array;
  try {
    accountKey = await open(wrapKey, bundle.wrappedAkPw, aad.akPw(bundle.userId));
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new WrongPasswordError("Wrong password", { cause: error });
    }
    throw error;
  }
  if (accountKey.length !== KEY_BYTES) throw new WrongPasswordError();
  try {
    const privateKey = await open(
      accountKey,
      bundle.encryptedPrivateKey,
      aad.privateKey(bundle.userId),
    );
    const publicKey = fromBase64Url(bundle.publicKey);
    if (
      privateKey.length !== KEY_BYTES ||
      !constantTimeEqual(sodium.crypto_scalarmult_base(privateKey), publicKey)
    ) {
      memzero(privateKey);
      throw new DecryptionError("Public key does not match the private key");
    }
    return { accountKey, publicKey, privateKey };
  } catch (error) {
    memzero(accountKey);
    throw error;
  }
}

/** Derive keys from the password and unlock locally (PLAN 10.3). Validates KDF params first. */
export async function unlockAccount(password: string, bundle: KeyBundle): Promise<AccountKeys> {
  const { authKey, wrapKey } = await derivePasswordKeys(password, bundle.salt, bundle.kdf);
  try {
    return await unlockAccountWithWrapKey(wrapKey, bundle);
  } finally {
    wipe(authKey, wrapKey);
  }
}

/** New salt, new keys, AK re-wrapped. No item is re-encrypted (PLAN 10.4). Also used for KDF upgrades. */
export async function buildPasswordChange(params: {
  accountKey: Uint8Array;
  userId: string;
  newPassword: string;
  kdf?: KdfParams;
}): Promise<PasswordChangeMaterial> {
  const { accountKey, userId, newPassword } = params;
  const kdf = params.kdf ?? DEFAULT_KDF;
  validateKdfParams(kdf);
  const newSalt = toBase64Url(await randomSalt());
  const { authKey, wrapKey } = await derivePasswordKeys(newPassword, newSalt, kdf);
  try {
    return {
      newSalt,
      newKdf: { alg: kdf.alg, mem: kdf.mem, ops: kdf.ops },
      newAuthKey: toBase64Url(authKey),
      newWrappedAk: await seal(wrapKey, accountKey, aad.akPw(userId)),
    };
  } finally {
    wipe(authKey, wrapKey);
  }
}

/**
 * Recover the account key from the 24-word phrase. A phrase that is well formed but does not
 * belong to this account also throws `InvalidRecoveryPhraseError`.
 */
export async function unwrapAccountKeyWithRecovery(
  phrase: string,
  userId: string,
  wrappedAkRec: string,
): Promise<Uint8Array> {
  const entropy = parseRecoveryPhrase(phrase);
  const keys = await deriveRecoveryKeys(entropy);
  try {
    const accountKey = await open(keys.recoveryWrapKey, wrappedAkRec, aad.akRec(userId));
    if (accountKey.length !== KEY_BYTES) throw new DecryptionError("Malformed account key");
    return accountKey;
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new InvalidRecoveryPhraseError("Recovery phrase does not match this account", {
        cause: error,
      });
    }
    throw error;
  } finally {
    wipe(entropy, keys.recoveryAuthKey, keys.recoveryWrapKey);
  }
}

/** Fresh recovery phrase wrapping the same AK; replaces the old kit (PLAN 10.5 A step 7). */
export async function buildRecoveryKit(params: {
  accountKey: Uint8Array;
  userId: string;
}): Promise<{ recoveryPhrase: string; material: RecoveryKitReplace }> {
  const recoveryPhrase = await generateRecoveryPhrase();
  const keys = await deriveRecoveryKeysFromPhrase(recoveryPhrase);
  try {
    return {
      recoveryPhrase,
      material: {
        wrappedAkRec: await seal(keys.recoveryWrapKey, params.accountKey, aad.akRec(params.userId)),
        recoveryAuthKey: toBase64Url(keys.recoveryAuthKey),
      },
    };
  } finally {
    wipe(keys.recoveryAuthKey, keys.recoveryWrapKey);
  }
}
