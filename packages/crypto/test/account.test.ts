import { beforeAll, describe, expect, it } from "vitest";
import {
  type AccountCreation,
  buildPasswordChange,
  buildRecoveryKit,
  type CreatedAccount,
  createAccount,
  createEncryptedItem,
  DEFAULT_KDF,
  DecryptionError,
  decryptItem,
  decryptVaultMeta,
  deriveAuthKeyForLogin,
  deriveLoginKeys,
  fromBase64Url,
  InvalidKdfParamsError,
  InvalidRecoveryPhraseError,
  type KeyBundle,
  openSealedKey,
  recoveryAuthKeyFromPhrase,
  toBase64Url,
  unlockAccount,
  unlockAccountWithWrapKey,
  unwrapAccountKeyWithRecovery,
  unwrapItemKey,
  WrongPasswordError,
} from "../src/index.ts";
import { FAST_KDF, I1, U1, V1 } from "./helpers.ts";

const PASSWORD = "correct horse battery staple";

function bundleOf(creation: AccountCreation): KeyBundle {
  const { user } = creation;
  return {
    userId: user.id,
    kdf: user.kdf,
    salt: user.salt,
    wrappedAkPw: user.wrappedAkPw,
    publicKey: user.publicKey,
    encryptedPrivateKey: user.encryptedPrivateKey,
    keyGeneration: 1,
  };
}

describe("account lifecycle (no server)", () => {
  let account: CreatedAccount;

  beforeAll(async () => {
    account = await createAccount({
      password: PASSWORD,
      userId: U1,
      vaultId: V1,
      vaultName: "Personal",
      kdf: FAST_KDF,
    });
  });

  it("produces the exact contract shape", () => {
    const { creation } = account;
    expect(Object.keys(creation).sort()).toEqual(["user", "vault"]);
    expect(Object.keys(creation.user).sort()).toEqual(
      [
        "authKey",
        "encryptedPrivateKey",
        "id",
        "kdf",
        "publicKey",
        "recoveryAuthKey",
        "salt",
        "wrappedAkPw",
        "wrappedAkRec",
      ].sort(),
    );
    expect(Object.keys(creation.vault).sort()).toEqual(
      ["encryptedMeta", "id", "keyVersion", "sealedKey"].sort(),
    );
    expect(creation.user.id).toBe(U1);
    expect(creation.vault.id).toBe(V1);
    expect(creation.vault.keyVersion).toBe(1);
    expect(creation.user.kdf).toEqual(FAST_KDF);
    expect(fromBase64Url(creation.user.salt)).toHaveLength(16);
    expect(fromBase64Url(creation.user.authKey)).toHaveLength(32);
    expect(fromBase64Url(creation.user.recoveryAuthKey)).toHaveLength(32);
    expect(fromBase64Url(creation.user.publicKey)).toHaveLength(32);
    expect(account.recoveryPhrase.split(" ")).toHaveLength(24);
    // Nothing secret leaks into the creation payload.
    const json = JSON.stringify(creation);
    expect(json).not.toContain(toBase64Url(account.keys.accountKey));
    expect(json).not.toContain(toBase64Url(account.keys.vaultKey));
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain(account.recoveryPhrase);
  });

  it("defaults to the default KDF params", async () => {
    // Real DEFAULT params (64 MiB, 3 passes) end to end.
    const real = await createAccount({ password: "pw", userId: U1, vaultId: V1, vaultName: "P" });
    expect(real.creation.user.kdf).toEqual(DEFAULT_KDF);
    const unlocked = await unlockAccount("pw", bundleOf(real.creation));
    expect(unlocked.accountKey).toEqual(real.keys.accountKey);
  });

  it("unlocks with the right password and returns the same keys", async () => {
    const unlocked = await unlockAccount(PASSWORD, bundleOf(account.creation));
    expect(unlocked.accountKey).toEqual(account.keys.accountKey);
    expect(unlocked.publicKey).toEqual(account.keys.publicKey);
    expect(unlocked.privateKey).toEqual(account.keys.privateKey);
  });

  it("throws WrongPasswordError for a wrong password", async () => {
    await expect(
      unlockAccount("wrong password", bundleOf(account.creation)),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("validates KDF params from the server before deriving anything", async () => {
    const bundle = { ...bundleOf(account.creation), kdf: { ...FAST_KDF, mem: 8192, ops: 1 } };
    await expect(unlockAccount(PASSWORD, bundle)).rejects.toBeInstanceOf(InvalidKdfParamsError);
  });

  it("login derivation matches creation and avoids a second Argon2 run", async () => {
    const { user } = account.creation;
    expect(await deriveAuthKeyForLogin(PASSWORD, user.salt, user.kdf)).toBe(user.authKey);
    const { authKey, wrapKey } = await deriveLoginKeys(PASSWORD, user.salt, user.kdf);
    expect(authKey).toBe(user.authKey);
    const unlocked = await unlockAccountWithWrapKey(wrapKey, bundleOf(account.creation));
    expect(unlocked.accountKey).toEqual(account.keys.accountKey);
    expect(await deriveAuthKeyForLogin("nope", user.salt, user.kdf)).not.toBe(user.authKey);
  });

  it("detects a swapped public key in the key bundle", async () => {
    const other = await createAccount({
      password: "x",
      userId: U1,
      vaultId: V1,
      vaultName: "x",
      kdf: FAST_KDF,
    });
    const bundle = { ...bundleOf(account.creation), publicKey: other.creation.user.publicKey };
    await expect(unlockAccount(PASSWORD, bundle)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a bundle moved to another user id (AAD binding)", async () => {
    const bundle = { ...bundleOf(account.creation), userId: "other-user" };
    await expect(unlockAccount(PASSWORD, bundle)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("opens the default vault key sealed to the user's own public key", async () => {
    const { vault } = account.creation;
    const vk = await openSealedKey(
      vault.sealedKey,
      account.keys.publicKey,
      account.keys.privateKey,
      {
        type: "vault",
        id: V1,
        keyVersion: 1,
      },
    );
    expect(vk).toEqual(account.keys.vaultKey);
    expect(await decryptVaultMeta(vk, V1, 1, vault.encryptedMeta)).toEqual({ name: "Personal" });
  });

  it("encrypts and decrypts items with the vault key", async () => {
    const content = { type: "login", title: "Example", password: "hunter2" };
    const { ik, wire } = await createEncryptedItem({
      vk: account.keys.vaultKey,
      vaultId: V1,
      vaultKeyVersion: 1,
      itemId: I1,
      content,
    });
    expect(wire.itemKeyVersion).toBe(1);
    expect(Object.keys(wire).sort()).toEqual(
      ["encryptedData", "id", "itemKeyVersion", "vaultId", "vaultKeyVersion", "wrappedKey"].sort(),
    );
    const ik2 = await unwrapItemKey(account.keys.vaultKey, V1, I1, 1, wire.wrappedKey);
    expect(ik2).toEqual(ik);
    expect(await decryptItem(ik2, I1, 1, wire.encryptedData)).toEqual(content);
  });

  it("password change: fresh salt, new password works, old fails, AK unchanged", async () => {
    const change = await buildPasswordChange({
      accountKey: account.keys.accountKey,
      userId: U1,
      newPassword: "a brand new password",
      kdf: FAST_KDF,
    });
    expect(Object.keys(change).sort()).toEqual(
      ["newAuthKey", "newKdf", "newSalt", "newWrappedAk"].sort(),
    );
    expect(change.newSalt).not.toBe(account.creation.user.salt);
    expect(change.newAuthKey).not.toBe(account.creation.user.authKey);

    const changed: KeyBundle = {
      ...bundleOf(account.creation),
      kdf: change.newKdf,
      salt: change.newSalt,
      wrappedAkPw: change.newWrappedAk,
    };
    const unlocked = await unlockAccount("a brand new password", changed);
    expect(unlocked.accountKey).toEqual(account.keys.accountKey);
    expect(unlocked.privateKey).toEqual(account.keys.privateKey);
    await expect(unlockAccount(PASSWORD, changed)).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await deriveAuthKeyForLogin("a brand new password", change.newSalt, change.newKdf)).toBe(
      change.newAuthKey,
    );
    // The old password still opens the old (pre-change) bundle, as documented in PLAN 10.0.
    await expect(unlockAccount(PASSWORD, bundleOf(account.creation))).resolves.toBeDefined();
  });

  it("password change refuses weak KDF params", async () => {
    await expect(
      buildPasswordChange({
        accountKey: account.keys.accountKey,
        userId: U1,
        newPassword: "x",
        kdf: { ...FAST_KDF, ops: 1 },
      }),
    ).rejects.toBeInstanceOf(InvalidKdfParamsError);
  });

  it("recovery: phrase unwraps AK, new kit replaces the old one", async () => {
    const ak = await unwrapAccountKeyWithRecovery(
      account.recoveryPhrase,
      U1,
      account.creation.user.wrappedAkRec,
    );
    expect(ak).toEqual(account.keys.accountKey);
    expect(await recoveryAuthKeyFromPhrase(account.recoveryPhrase)).toBe(
      account.creation.user.recoveryAuthKey,
    );

    // Normalisation is applied to what the user types.
    const typed = `  ${account.recoveryPhrase.toUpperCase().replace(/ /g, "   ")} `;
    expect(
      await unwrapAccountKeyWithRecovery(typed, U1, account.creation.user.wrappedAkRec),
    ).toEqual(ak);

    // User sets a new password with the recovered AK, then regenerates the kit.
    const change = await buildPasswordChange({
      accountKey: ak,
      userId: U1,
      newPassword: "post recovery password",
      kdf: FAST_KDF,
    });
    const kit = await buildRecoveryKit({ accountKey: ak, userId: U1 });
    expect(kit.recoveryPhrase).not.toBe(account.recoveryPhrase);
    expect(kit.recoveryPhrase.split(" ")).toHaveLength(24);
    expect(Object.keys(kit.material).sort()).toEqual(["recoveryAuthKey", "wrappedAkRec"]);
    expect(kit.material.recoveryAuthKey).toBe(await recoveryAuthKeyFromPhrase(kit.recoveryPhrase));
    expect(kit.material.recoveryAuthKey).not.toBe(account.creation.user.recoveryAuthKey);

    expect(
      await unwrapAccountKeyWithRecovery(kit.recoveryPhrase, U1, kit.material.wrappedAkRec),
    ).toEqual(account.keys.accountKey);
    // The old phrase cannot open the new wrapped copy.
    await expect(
      unwrapAccountKeyWithRecovery(account.recoveryPhrase, U1, kit.material.wrappedAkRec),
    ).rejects.toBeInstanceOf(InvalidRecoveryPhraseError);

    const afterRecovery: KeyBundle = {
      ...bundleOf(account.creation),
      kdf: change.newKdf,
      salt: change.newSalt,
      wrappedAkPw: change.newWrappedAk,
    };
    expect((await unlockAccount("post recovery password", afterRecovery)).accountKey).toEqual(ak);
  });

  it("recovery rejects a malformed phrase, another account's phrase, and another user id", async () => {
    await expect(
      unwrapAccountKeyWithRecovery("not a phrase", U1, account.creation.user.wrappedAkRec),
    ).rejects.toBeInstanceOf(InvalidRecoveryPhraseError);
    const other = await createAccount({
      password: "x",
      userId: U1,
      vaultId: V1,
      vaultName: "x",
      kdf: FAST_KDF,
    });
    await expect(
      unwrapAccountKeyWithRecovery(other.recoveryPhrase, U1, account.creation.user.wrappedAkRec),
    ).rejects.toBeInstanceOf(InvalidRecoveryPhraseError);
    await expect(
      unwrapAccountKeyWithRecovery(
        account.recoveryPhrase,
        "other-user",
        account.creation.user.wrappedAkRec,
      ),
    ).rejects.toBeInstanceOf(InvalidRecoveryPhraseError);
  });
});
