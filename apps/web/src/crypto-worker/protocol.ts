import type {
  AccountCreation,
  ChangePasswordRequest,
  KdfParams,
  KeyBundle,
  PasswordChange,
  RecoveryKitReplace,
} from "@pm/shared";
import type { VaultOpMap } from "./vault-protocol.ts";

/**
 * Typed message protocol between the UI thread and the crypto Web Worker (PLAN.md section 15).
 * This file is imported by the UI, so it must only contain types and constants (no @pm/crypto).
 *
 * A request carries an id; the worker answers with a response with the same id. Errors cross
 * the boundary as `{ name, code, message }`; `code` is the stable part (see `CRYPTO_ERROR`).
 */

/** One operation: its argument type (`undefined` for none) and its result type. */
export type Op<A, R> = { args: A; result: R };

/** Stable error codes. `@pm/crypto` error classes map to the first group. */
export const CRYPTO_ERROR = {
  wrongPassword: "wrong_password",
  invalidRecoveryPhrase: "invalid_recovery_phrase",
  decryptionFailed: "decryption_failed",
  invalidKdfParams: "invalid_kdf_params",
  sealedKeyMismatch: "sealed_key_mismatch",
  /** The operation needs the vault to be unlocked. */
  locked: "locked",
  /** `completeLogin` / `commitAccountCreation` without the step before it. */
  noPendingLogin: "no_pending_login",
  noPendingAccount: "no_pending_account",
  /** The worker was locked or replaced while the operation was running. */
  cancelled: "cancelled",
  unknownOp: "unknown_op",
  workerCrashed: "worker_crashed",
  workerError: "worker_error",
} as const;
export type CryptoErrorCode = (typeof CRYPTO_ERROR)[keyof typeof CRYPTO_ERROR];

/** Material for `POST /me/kdf-upgrade` (same shape as a password change). */
export type KdfUpgrade = ChangePasswordRequest;

export type UnlockResult = {
  userId: string;
  /** Present when the stored KDF parameters are weaker than the current defaults (PLAN 9.1). */
  kdfUpgrade: KdfUpgrade | null;
};

export type AccountOpMap = {
  /**
   * Generate all key material for a new account (invite acceptance or account reset). The keys
   * stay in the worker as "pending" until `commitAccountCreation`.
   */
  createAccount: Op<
    { password: string; vaultName?: string },
    { creation: AccountCreation; recoveryPhrase: string }
  >;
  /** The server accepted the creation: make the pending keys the active (unlocked) state. */
  commitAccountCreation: Op<undefined, { userId: string }>;

  /** Step 1 of login: Argon2id once. Returns the authKey; the wrapKey stays pending. */
  login: Op<{ password: string; salt: string; kdf: KdfParams }, { authKey: string }>;
  /** Step 2 of login: the key bundle arrived, unlock with the pending wrapKey. */
  completeLogin: Op<KeyBundle, UnlockResult>;
  /** Unlock from a locked state with the typed password and `GET /me/keys`. */
  unlock: Op<{ password: string; keyBundle: KeyBundle }, UnlockResult>;
  lock: Op<undefined, void>;
  isUnlocked: Op<undefined, { unlocked: boolean; userId: string | null }>;

  /** authKey for the current password, verified locally (delete account, etc.). */
  deriveAuthKey: Op<{ password: string; keyBundle: KeyBundle }, { authKey: string }>;
  /** PLAN 10.4. Verifies `currentPassword` locally, then builds the new password material. */
  buildPasswordChange: Op<
    { currentPassword: string; newPassword: string; keyBundle: KeyBundle },
    { currentAuthKey: string; material: PasswordChange }
  >;
  /** PLAN 10.5 B: new password material from the unlocked account key (no current password). */
  buildPasswordReset: Op<{ newPassword: string }, { material: PasswordChange }>;

  /** PLAN 10.5 A step 2. */
  startRecovery: Op<{ phrase: string }, { recoveryAuthKey: string }>;
  /** PLAN 10.5 A step 5. Leaves a pending login so `completeLogin` can finish. */
  completeRecovery: Op<
    { phrase: string; userId: string; wrappedAkRec: string; newPassword: string },
    { material: PasswordChange }
  >;
  /** New recovery phrase for the unlocked account. The caller shows it, then posts `material`. */
  buildRecoveryKit: Op<undefined, { recoveryPhrase: string; material: RecoveryKitReplace }>;

  kdfNeedsUpgrade: Op<{ kdf: KdfParams }, { needsUpgrade: boolean }>;
  buildKdfUpgrade: Op<{ password: string; keyBundle: KeyBundle }, { upgrade: KdfUpgrade }>;
};

export type OpMap = AccountOpMap & VaultOpMap;
export type OpName = keyof OpMap & string;
export type OpArgs<K extends OpName> = OpMap[K]["args"];
export type OpResult<K extends OpName> = OpMap[K]["result"];

/** Rest-parameter helper: ops without arguments are called as `call("lock")`. */
export type CallArgs<K extends OpName> = [OpArgs<K>] extends [undefined] ? [] : [args: OpArgs<K>];

export interface WorkerRequest {
  id: number;
  op: string;
  args: unknown;
}

export interface SerializedError {
  name: string;
  code: string;
  message: string;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedError };

/** Handler implementations, one function per operation of `M`. */
export type Handlers<M> = {
  [K in keyof M]: M[K] extends Op<infer A, infer R> ? (args: A) => Promise<R> : never;
};

export type { KeyBundle, PasswordChange };
