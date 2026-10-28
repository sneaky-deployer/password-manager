import { CryptoError, wipe } from "@pm/crypto";
import { CRYPTO_ERROR } from "./protocol.ts";

/** Keys of an account whose creation the server has not confirmed yet. */
export interface PendingCreation {
  userId: string;
  vaultId: string;
  accountKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  vaultKey: Uint8Array;
}

/** Between `login` and `completeLogin` (and through a 2FA step). */
export interface PendingLogin {
  wrapKey: Uint8Array;
  /** Kept only to build a KDF upgrade after unlocking; dropped by `completeLogin`. */
  password: string | null;
  /** base64url authKey that was sent to the server (the proof for `/me/kdf-upgrade`). */
  authKey: string;
}

export interface ActiveKeys {
  userId: string;
  accountKey: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Everything the worker holds. Nothing here ever crosses to the UI thread.
 * `vaultKeys` is filled by the vault ops (vaultId -> key version -> vault key).
 */
export interface WorkerState {
  userId: string | null;
  accountKey: Uint8Array | null;
  privateKey: Uint8Array | null;
  publicKey: Uint8Array | null;
  vaultKeys: Map<string, Map<number, Uint8Array>>;
  pendingLogin: PendingLogin | null;
  pendingCreation: PendingCreation | null;
  /** Incremented by every `lock()`; long operations compare it to detect a lock meanwhile. */
  epoch: number;
  isUnlocked(): boolean;
  /** Replace the active keys (wipes the previous ones). */
  setUnlocked(keys: ActiveKeys): void;
  /** Throws a `locked` error unless unlocked. Use at the start of every key-using op. */
  requireUnlocked(): ActiveKeys;
  /** Wipe the pending login/creation material only. */
  clearPending(): void;
  /** Wipe every key and pending material. Safe to call repeatedly. */
  lock(): void;
}

function wipeVaultKeys(vaultKeys: Map<string, Map<number, Uint8Array>>): void {
  for (const versions of vaultKeys.values()) {
    for (const key of versions.values()) wipe(key);
    versions.clear();
  }
  vaultKeys.clear();
}

export function createWorkerState(): WorkerState {
  const state: WorkerState = {
    userId: null,
    accountKey: null,
    privateKey: null,
    publicKey: null,
    vaultKeys: new Map(),
    pendingLogin: null,
    pendingCreation: null,
    epoch: 0,

    isUnlocked() {
      return state.userId !== null && state.accountKey !== null && state.privateKey !== null;
    },

    setUnlocked(keys) {
      wipe(state.accountKey, state.privateKey, state.publicKey);
      wipeVaultKeys(state.vaultKeys);
      state.userId = keys.userId;
      state.accountKey = keys.accountKey;
      state.privateKey = keys.privateKey;
      state.publicKey = keys.publicKey;
    },

    requireUnlocked() {
      const { userId, accountKey, privateKey, publicKey } = state;
      if (!userId || !accountKey || !privateKey || !publicKey) {
        throw new CryptoError(CRYPTO_ERROR.locked, "The vault is locked");
      }
      return { userId, accountKey, privateKey, publicKey };
    },

    clearPending() {
      if (state.pendingLogin) wipe(state.pendingLogin.wrapKey);
      state.pendingLogin = null;
      if (state.pendingCreation) {
        const p = state.pendingCreation;
        wipe(p.accountKey, p.privateKey, p.publicKey, p.vaultKey);
      }
      state.pendingCreation = null;
    },

    lock() {
      state.epoch += 1;
      state.clearPending();
      wipe(state.accountKey, state.privateKey, state.publicKey);
      wipeVaultKeys(state.vaultKeys);
      state.userId = null;
      state.accountKey = null;
      state.privateKey = null;
      state.publicKey = null;
    },
  };
  return state;
}
