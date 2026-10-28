// @vitest-environment node
import { type KdfParams, unlockAccount } from "@pm/crypto";
import { accountCreationSchema, type KeyBundle } from "@pm/shared";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "../dispatch.ts";
import type { OpArgs, OpName, OpResult } from "../protocol.ts";
import { createHandlers } from "../registry.ts";
import { createWorkerState } from "../state.ts";

/** Minimum Argon2id parameters the crypto package accepts, to keep tests fast. */
const FAST_KDF: KdfParams = { alg: "argon2id13", mem: 16 * 1024 * 1024, ops: 2 };

function setup(kdf: KdfParams = FAST_KDF) {
  const state = createWorkerState();
  const handlers = createHandlers(state, { kdf });
  const dispatch = createDispatcher(handlers);
  let nextId = 0;
  async function call<K extends OpName>(op: K, args?: OpArgs<K>): Promise<OpResult<K>> {
    const response = await dispatch({ id: ++nextId, op, args });
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    return response.result as OpResult<K>;
  }
  async function callError(op: OpName, args?: unknown) {
    const response = await dispatch({ id: ++nextId, op, args });
    if (response.ok) throw new Error("expected an error");
    return response.error;
  }
  return { state, handlers, dispatch, call, callError };
}

type Creation = OpResult<"createAccount">["creation"];

function bundleFrom(creation: Creation): KeyBundle {
  return {
    userId: creation.user.id,
    kdf: creation.user.kdf,
    salt: creation.user.salt,
    wrappedAkPw: creation.user.wrappedAkPw,
    publicKey: creation.user.publicKey,
    encryptedPrivateKey: creation.user.encryptedPrivateKey,
    keyGeneration: 1,
  };
}

const PASSWORD = "correct horse battery staple";

async function createdAccount(s: ReturnType<typeof setup>) {
  const { creation, recoveryPhrase } = await s.call("createAccount", { password: PASSWORD });
  await s.call("commitAccountCreation");
  await s.call("lock");
  return { creation, recoveryPhrase, bundle: bundleFrom(creation) };
}

describe("crypto worker account handlers", () => {
  it("creates an account that matches the API schema and stays pending until committed", async () => {
    const s = setup();
    const { creation, recoveryPhrase } = await s.call("createAccount", { password: PASSWORD });
    expect(accountCreationSchema.safeParse(creation).success).toBe(true);
    expect(recoveryPhrase.split(" ")).toHaveLength(24);
    expect(await s.call("isUnlocked")).toEqual({ unlocked: false, userId: null });

    const { userId } = await s.call("commitAccountCreation");
    expect(userId).toBe(creation.user.id);
    expect(await s.call("isUnlocked")).toEqual({ unlocked: true, userId });
    expect(s.state.vaultKeys.get(creation.vault.id)?.get(1)).toHaveLength(32);
  });

  it("does not leak keys in any result", async () => {
    const s = setup();
    const result = await s.call("createAccount", { password: PASSWORD });
    const json = JSON.stringify(result);
    expect(json).not.toContain("privateKey");
    expect(json).not.toContain("accountKey");
    expect(result.creation.user.authKey).toHaveLength(43);
  });

  it("login derives the authKey once and completeLogin unlocks with the pending wrapKey", async () => {
    const s = setup();
    const { creation, bundle } = await createdAccount(s);
    const { authKey } = await s.call("login", {
      password: PASSWORD,
      salt: bundle.salt,
      kdf: bundle.kdf,
    });
    expect(authKey).toBe(creation.user.authKey);
    expect(s.state.isUnlocked()).toBe(false);

    const result = await s.call("completeLogin", bundle);
    expect(result).toEqual({ userId: bundle.userId, kdfUpgrade: null });
    expect(s.state.isUnlocked()).toBe(true);
    expect(s.state.pendingLogin).toBeNull();
  });

  it("completeLogin without a login, or with a bundle for another password, fails", async () => {
    const s = setup();
    const { bundle } = await createdAccount(s);
    expect((await s.callError("completeLogin", bundle)).code).toBe("no_pending_login");

    await s.call("login", {
      password: "a completely different password",
      salt: bundle.salt,
      kdf: bundle.kdf,
    });
    expect((await s.callError("completeLogin", bundle)).code).toBe("wrong_password");
    expect(s.state.pendingLogin).toBeNull();
    expect(s.state.isUnlocked()).toBe(false);
  });

  it("lock wipes every key buffer", async () => {
    const s = setup();
    const { bundle } = await createdAccount(s);
    await s.call("unlock", { password: PASSWORD, keyBundle: bundle });
    const { accountKey, privateKey } = s.state.requireUnlocked();
    const vaultKeys = [...s.state.vaultKeys.values()].flatMap((m) => [...m.values()]);
    expect(accountKey.some((b) => b !== 0)).toBe(true);

    await s.call("lock");
    expect(accountKey.every((b) => b === 0)).toBe(true);
    expect(privateKey.every((b) => b === 0)).toBe(true);
    expect(vaultKeys.every((k) => k.every((b) => b === 0))).toBe(true);
    expect(s.state.isUnlocked()).toBe(false);
    expect(s.state.accountKey).toBeNull();
    expect(s.state.vaultKeys.size).toBe(0);
  });

  it("lock also wipes the pending wrapKey and a pending creation", async () => {
    const s = setup();
    const { bundle } = await createdAccount(s);
    await s.call("login", { password: PASSWORD, salt: bundle.salt, kdf: bundle.kdf });
    const wrapKey = s.state.pendingLogin?.wrapKey as Uint8Array;
    await s.call("createAccount", { password: PASSWORD });
    expect(s.state.pendingLogin).toBeNull(); // createAccount locks first
    expect(wrapKey.every((b) => b === 0)).toBe(true);
    const pendingAk = s.state.pendingCreation?.accountKey as Uint8Array;
    await s.call("lock");
    expect(pendingAk.every((b) => b === 0)).toBe(true);
    expect(s.state.pendingCreation).toBeNull();
  });

  it("unlock with the wrong password errors with wrong_password and stays locked", async () => {
    const s = setup();
    const { bundle } = await createdAccount(s);
    const error = await s.callError("unlock", { password: "not the password", keyBundle: bundle });
    expect(error.code).toBe("wrong_password");
    expect(error.name).toBe("WrongPasswordError");
    expect(s.state.isUnlocked()).toBe(false);

    await s.call("unlock", { password: PASSWORD, keyBundle: bundle });
    expect(s.state.isUnlocked()).toBe(true);
  });

  it("unlock refuses KDF parameters below the minimum", async () => {
    const s = setup();
    const { bundle } = await createdAccount(s);
    const weak = { ...bundle, kdf: { ...bundle.kdf, mem: 1024 } };
    expect((await s.callError("unlock", { password: PASSWORD, keyBundle: weak })).code).toBe(
      "invalid_kdf_params",
    );
  });

  it("returns KDF upgrade material when the stored parameters are weaker than the target", async () => {
    const creator = setup();
    const { bundle } = await createdAccount(creator);
    const target: KdfParams = { alg: "argon2id13", mem: 32 * 1024 * 1024, ops: 2 };
    const s = setup(target);
    expect(await s.call("kdfNeedsUpgrade", { kdf: bundle.kdf })).toEqual({ needsUpgrade: true });
    expect(await s.call("kdfNeedsUpgrade", { kdf: target })).toEqual({ needsUpgrade: false });

    const { kdfUpgrade } = await s.call("unlock", { password: PASSWORD, keyBundle: bundle });
    expect(kdfUpgrade?.newKdf).toEqual(target);
    expect(kdfUpgrade?.currentAuthKey).toHaveLength(43);

    // The upgraded material unlocks with the same password.
    const upgraded: KeyBundle = {
      ...bundle,
      salt: kdfUpgrade?.newSalt as string,
      kdf: target,
      wrappedAkPw: kdfUpgrade?.newWrappedAk as string,
    };
    await expect(unlockAccount(PASSWORD, upgraded)).resolves.toBeDefined();

    const explicit = await s.call("buildKdfUpgrade", { password: PASSWORD, keyBundle: bundle });
    expect(explicit.upgrade.newKdf).toEqual(target);
  });

  it("buildPasswordChange verifies the current password and produces usable material", async () => {
    const s = setup();
    const { creation, bundle } = await createdAccount(s);
    await s.call("unlock", { password: PASSWORD, keyBundle: bundle });

    const wrong = await s.callError("buildPasswordChange", {
      currentPassword: "nope nope nope nope",
      newPassword: "a brand new password 123",
      keyBundle: bundle,
    });
    expect(wrong.code).toBe("wrong_password");

    const { currentAuthKey, material } = await s.call("buildPasswordChange", {
      currentPassword: PASSWORD,
      newPassword: "a brand new password 123",
      keyBundle: bundle,
    });
    expect(currentAuthKey).toBe(creation.user.authKey);
    expect(material.newSalt).not.toBe(bundle.salt);
    await expect(
      unlockAccount("a brand new password 123", {
        ...bundle,
        salt: material.newSalt,
        kdf: material.newKdf,
        wrappedAkPw: material.newWrappedAk,
      }),
    ).resolves.toBeDefined();
  });

  it("password and key-using ops need an unlocked worker", async () => {
    const s = setup();
    const { bundle } = await createdAccount(s);
    expect(
      (
        await s.callError("buildPasswordChange", {
          currentPassword: PASSWORD,
          newPassword: "x".repeat(14),
          keyBundle: bundle,
        })
      ).code,
    ).toBe("locked");
    expect((await s.callError("buildRecoveryKit")).code).toBe("locked");
    expect((await s.callError("buildPasswordReset", { newPassword: "x".repeat(14) })).code).toBe(
      "locked",
    );
  });

  it("recovers with the phrase: startRecovery key matches, completeRecovery leads to completeLogin", async () => {
    const s = setup();
    const { creation, recoveryPhrase, bundle } = await createdAccount(s);

    const { recoveryAuthKey } = await s.call("startRecovery", { phrase: recoveryPhrase });
    expect(recoveryAuthKey).toBe(creation.user.recoveryAuthKey);

    const bad = await s.callError("startRecovery", { phrase: "abandon ability able" });
    expect(bad.code).toBe("invalid_recovery_phrase");

    const { material } = await s.call("completeRecovery", {
      phrase: recoveryPhrase,
      userId: bundle.userId,
      wrappedAkRec: creation.user.wrappedAkRec,
      newPassword: "recovered password 456",
    });
    expect(s.state.isUnlocked()).toBe(false);

    // The server would answer with a bundle holding the new password material.
    const newBundle: KeyBundle = {
      ...bundle,
      salt: material.newSalt,
      kdf: material.newKdf,
      wrappedAkPw: material.newWrappedAk,
    };
    expect((await s.call("completeLogin", newBundle)).userId).toBe(bundle.userId);
    expect(s.state.isUnlocked()).toBe(true);
  });

  it("completeRecovery with a phrase from another account fails", async () => {
    const s = setup();
    const { creation, bundle } = await createdAccount(s);
    const other = await setup().call("createAccount", { password: "another account password" });
    const error = await s.callError("completeRecovery", {
      phrase: other.recoveryPhrase,
      userId: bundle.userId,
      wrappedAkRec: creation.user.wrappedAkRec,
      newPassword: "recovered password 456",
    });
    expect(error.code).toBe("invalid_recovery_phrase");
  });

  it("buildRecoveryKit returns a fresh phrase whose key matches the material", async () => {
    const s = setup();
    const { recoveryPhrase, bundle } = await createdAccount(s);
    await s.call("unlock", { password: PASSWORD, keyBundle: bundle });
    const kit = await s.call("buildRecoveryKit");
    expect(kit.recoveryPhrase).not.toBe(recoveryPhrase);
    const { recoveryAuthKey } = await s.call("startRecovery", { phrase: kit.recoveryPhrase });
    expect(recoveryAuthKey).toBe(kit.material.recoveryAuthKey);
  });

  it("deriveAuthKey verifies the password locally", async () => {
    const s = setup();
    const { creation, bundle } = await createdAccount(s);
    expect((await s.call("deriveAuthKey", { password: PASSWORD, keyBundle: bundle })).authKey).toBe(
      creation.user.authKey,
    );
    expect(
      (await s.callError("deriveAuthKey", { password: "wrong wrong wrong", keyBundle: bundle }))
        .code,
    ).toBe("wrong_password");
  });

  it("answers unknown operations with an error instead of throwing", async () => {
    const s = setup();
    expect((await s.callError("nope" as OpName)).code).toBe("unknown_op");
  });
});
