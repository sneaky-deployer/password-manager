import {
  type AccountKeys,
  buildPasswordChange as buildPasswordChangeMaterial,
  buildRecoveryKit as buildRecoveryKitMaterial,
  CryptoError,
  createAccount as createAccountMaterial,
  DEFAULT_KDF,
  deriveLoginKeys,
  type KdfParams,
  kdfNeedsUpgrade,
  recoveryAuthKeyFromPhrase,
  unlockAccountWithWrapKey,
  unwrapAccountKeyWithRecovery,
  wipe,
} from "@pm/crypto";
import {
  type AccountOpMap,
  CRYPTO_ERROR,
  type Handlers,
  type KdfUpgrade,
  type KeyBundle,
} from "../protocol.ts";
import type { HandlerOptions } from "../registry.ts";
import type { WorkerState } from "../state.ts";

const DEFAULT_VAULT_NAME = "Personal";

/** Account, login, lock/unlock, password change and recovery operations (PLAN.md section 10). */
export function createAccountHandlers(
  state: WorkerState,
  options: HandlerOptions = {},
): Handlers<AccountOpMap> {
  const targetKdf: KdfParams = options.kdf ?? DEFAULT_KDF;
  const needsUpgrade = (kdf: KdfParams): boolean =>
    options.kdf ? kdf.mem < targetKdf.mem || kdf.ops < targetKdf.ops : kdfNeedsUpgrade(kdf);

  function cancelled(): CryptoError {
    return new CryptoError(CRYPTO_ERROR.cancelled, "The operation was cancelled by a lock");
  }

  /** Derive from the typed password and prove it against the bundle. Caller wipes the result. */
  async function verifyPassword(
    password: string,
    bundle: KeyBundle,
  ): Promise<{ authKey: string; keys: AccountKeys }> {
    const { authKey, wrapKey } = await deriveLoginKeys(password, bundle.salt, bundle.kdf);
    try {
      return { authKey, keys: await unlockAccountWithWrapKey(wrapKey, bundle) };
    } finally {
      wipe(wrapKey);
    }
  }

  /** KDF upgrade material when the stored parameters are weak. Failure must not block unlock. */
  async function maybeKdfUpgrade(
    password: string,
    currentAuthKey: string,
    keys: ActiveKeysLike,
    kdf: KdfParams,
  ): Promise<KdfUpgrade | null> {
    if (!needsUpgrade(kdf)) return null;
    try {
      const material = await buildPasswordChangeMaterial({
        accountKey: keys.accountKey,
        userId: keys.userId,
        newPassword: password,
        kdf: targetKdf,
      });
      return { currentAuthKey, ...material };
    } catch {
      return null;
    }
  }

  return {
    async createAccount({ password, vaultName }) {
      state.lock();
      const epoch = state.epoch;
      const userId = crypto.randomUUID();
      const vaultId = crypto.randomUUID();
      const created = await createAccountMaterial({
        password,
        userId,
        vaultId,
        vaultName: vaultName ?? DEFAULT_VAULT_NAME,
        kdf: targetKdf,
      });
      if (state.epoch !== epoch) {
        wipe(created.keys.accountKey, created.keys.privateKey, created.keys.vaultKey);
        throw cancelled();
      }
      state.pendingCreation = {
        userId,
        vaultId,
        accountKey: created.keys.accountKey,
        privateKey: created.keys.privateKey,
        publicKey: created.keys.publicKey,
        vaultKey: created.keys.vaultKey,
      };
      return { creation: created.creation, recoveryPhrase: created.recoveryPhrase };
    },

    async commitAccountCreation() {
      const pending = state.pendingCreation;
      if (!pending) {
        throw new CryptoError(CRYPTO_ERROR.noPendingAccount, "No account creation is pending");
      }
      state.pendingCreation = null;
      state.setUnlocked({
        userId: pending.userId,
        accountKey: pending.accountKey,
        privateKey: pending.privateKey,
        publicKey: pending.publicKey,
      });
      state.vaultKeys.set(pending.vaultId, new Map([[1, pending.vaultKey]]));
      return { userId: pending.userId };
    },

    async login({ password, salt, kdf }) {
      state.lock();
      const epoch = state.epoch;
      const { authKey, wrapKey } = await deriveLoginKeys(password, salt, kdf);
      if (state.epoch !== epoch) {
        wipe(wrapKey);
        throw cancelled();
      }
      state.pendingLogin = { wrapKey, password, authKey };
      return { authKey };
    },

    async completeLogin(bundle) {
      const pending = state.pendingLogin;
      if (!pending) {
        throw new CryptoError(CRYPTO_ERROR.noPendingLogin, "No login is pending");
      }
      const epoch = state.epoch;
      try {
        const keys = await unlockAccountWithWrapKey(pending.wrapKey, bundle);
        if (state.epoch !== epoch) {
          wipe(keys.accountKey, keys.privateKey);
          throw cancelled();
        }
        const active = { userId: bundle.userId, ...keys };
        state.pendingLogin = null;
        const kdfUpgrade = pending.password
          ? await maybeKdfUpgrade(pending.password, pending.authKey, active, bundle.kdf)
          : null;
        wipe(pending.wrapKey);
        if (state.epoch !== epoch) {
          wipe(keys.accountKey, keys.privateKey);
          throw cancelled();
        }
        state.setUnlocked(active);
        return { userId: bundle.userId, kdfUpgrade };
      } catch (error) {
        if (state.pendingLogin === pending) state.clearPending();
        throw error;
      }
    },

    async unlock({ password, keyBundle }) {
      const epoch = state.epoch;
      const { authKey, keys } = await verifyPassword(password, keyBundle);
      if (state.epoch !== epoch) {
        wipe(keys.accountKey, keys.privateKey);
        throw cancelled();
      }
      const active = { userId: keyBundle.userId, ...keys };
      const kdfUpgrade = await maybeKdfUpgrade(password, authKey, active, keyBundle.kdf);
      state.setUnlocked(active);
      return { userId: keyBundle.userId, kdfUpgrade };
    },

    async lock() {
      state.lock();
    },

    async isUnlocked() {
      return { unlocked: state.isUnlocked(), userId: state.userId };
    },

    async deriveAuthKey({ password, keyBundle }) {
      const { authKey, keys } = await verifyPassword(password, keyBundle);
      wipe(keys.accountKey, keys.privateKey);
      return { authKey };
    },

    async buildPasswordChange({ currentPassword, newPassword, keyBundle }) {
      const active = state.requireUnlocked();
      if (keyBundle.userId !== active.userId) {
        throw new CryptoError(CRYPTO_ERROR.decryptionFailed, "Key bundle belongs to another user");
      }
      const { authKey, keys } = await verifyPassword(currentPassword, keyBundle);
      wipe(keys.accountKey, keys.privateKey);
      const material = await buildPasswordChangeMaterial({
        accountKey: active.accountKey,
        userId: active.userId,
        newPassword,
        kdf: targetKdf,
      });
      return { currentAuthKey: authKey, material };
    },

    async buildPasswordReset({ newPassword }) {
      const active = state.requireUnlocked();
      const material = await buildPasswordChangeMaterial({
        accountKey: active.accountKey,
        userId: active.userId,
        newPassword,
        kdf: targetKdf,
      });
      return { material };
    },

    async startRecovery({ phrase }) {
      return { recoveryAuthKey: await recoveryAuthKeyFromPhrase(phrase) };
    },

    async completeRecovery({ phrase, userId, wrappedAkRec, newPassword }) {
      state.lock();
      const epoch = state.epoch;
      const accountKey = await unwrapAccountKeyWithRecovery(phrase, userId, wrappedAkRec);
      try {
        const material = await buildPasswordChangeMaterial({
          accountKey,
          userId,
          newPassword,
          kdf: targetKdf,
        });
        // The server answers recovery/complete with a key bundle; unlocking it needs the new
        // wrapKey, so derive it once more (the account key itself is not kept).
        const { authKey, wrapKey } = await deriveLoginKeys(
          newPassword,
          material.newSalt,
          material.newKdf,
        );
        if (state.epoch !== epoch) {
          wipe(wrapKey);
          throw cancelled();
        }
        state.pendingLogin = { wrapKey, password: null, authKey };
        return { material };
      } finally {
        wipe(accountKey);
      }
    },

    async buildRecoveryKit() {
      const active = state.requireUnlocked();
      return buildRecoveryKitMaterial({ accountKey: active.accountKey, userId: active.userId });
    },

    async kdfNeedsUpgrade({ kdf }) {
      return { needsUpgrade: needsUpgrade(kdf) };
    },

    async buildKdfUpgrade({ password, keyBundle }) {
      const { authKey, keys } = await verifyPassword(password, keyBundle);
      try {
        const material = await buildPasswordChangeMaterial({
          accountKey: keys.accountKey,
          userId: keyBundle.userId,
          newPassword: password,
          kdf: targetKdf,
        });
        return { upgrade: { currentAuthKey: authKey, ...material } };
      } finally {
        wipe(keys.accountKey, keys.privateKey);
      }
    },
  };
}

type ActiveKeysLike = { userId: string; accountKey: Uint8Array };
