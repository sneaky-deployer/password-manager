import { beforeAll, describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptVaultMeta,
  encryptVaultMeta,
  generateKey,
  openSealedKey,
  SealedKeyMismatchError,
  sealKey,
  sodiumReady,
  toBase64Url,
  UnsupportedVersionError,
  utf8Encode,
} from "../src/index.ts";
import { I1, V1, V2 } from "./helpers.ts";

type Pair = { publicKey: Uint8Array; privateKey: Uint8Array };
let alice: Pair;
let bob: Pair;

beforeAll(async () => {
  const sodium = await sodiumReady();
  alice = sodium.crypto_box_keypair();
  bob = sodium.crypto_box_keypair();
});

describe("sealed keys", () => {
  it("round-trips a vault key", async () => {
    const vk = await generateKey();
    const sealed = await sealKey(alice.publicKey, {
      type: "vault",
      id: V1,
      keyVersion: 3,
      key: vk,
    });
    const opened = await openSealedKey(sealed, alice.publicKey, alice.privateKey, {
      type: "vault",
      id: V1,
      keyVersion: 3,
    });
    expect(opened).toEqual(vk);
  });

  it("accepts a base64url public key string", async () => {
    const ik = await generateKey();
    const sealed = await sealKey(toBase64Url(alice.publicKey), {
      type: "item",
      id: I1,
      keyVersion: 1,
      key: ik,
    });
    expect(
      await openSealedKey(sealed, toBase64Url(alice.publicKey), alice.privateKey, {
        type: "item",
        id: I1,
        keyVersion: 1,
      }),
    ).toEqual(ik);
  });

  it("detects mismatched type, id and key version", async () => {
    const sealed = await sealKey(alice.publicKey, {
      type: "vault",
      id: V1,
      keyVersion: 1,
      key: await generateKey(),
    });
    const expectations = [
      { type: "item", id: V1, keyVersion: 1 },
      { type: "vault", id: V2, keyVersion: 1 },
      { type: "vault", id: V1, keyVersion: 2 },
    ] as const;
    for (const expected of expectations) {
      await expect(
        openSealedKey(sealed, alice.publicKey, alice.privateKey, expected),
      ).rejects.toBeInstanceOf(SealedKeyMismatchError);
    }
  });

  it("sharing: a second user opens the sealed VK and reads vault data; others cannot", async () => {
    const vk = await generateKey();
    const meta = await encryptVaultMeta(vk, V1, 1, { name: "Family" });
    const sealedForBob = await sealKey(bob.publicKey, {
      type: "vault",
      id: V1,
      keyVersion: 1,
      key: vk,
    });
    const bobVk = await openSealedKey(sealedForBob, bob.publicKey, bob.privateKey, {
      type: "vault",
      id: V1,
      keyVersion: 1,
    });
    expect(await decryptVaultMeta(bobVk, V1, 1, meta)).toEqual({ name: "Family" });
    await expect(
      openSealedKey(sealedForBob, alice.publicKey, alice.privateKey, {
        type: "vault",
        id: V1,
        keyVersion: 1,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects tampered or malformed sealed boxes", async () => {
    const sealed = await sealKey(alice.publicKey, {
      type: "vault",
      id: V1,
      keyVersion: 1,
      key: await generateKey(),
    });
    const expected = { type: "vault", id: V1, keyVersion: 1 } as const;
    const tampered = `${sealed.slice(0, 10)}${sealed[10] === "A" ? "B" : "A"}${sealed.slice(11)}`;
    await expect(
      openSealedKey(tampered, alice.publicKey, alice.privateKey, expected),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      openSealedKey("%%%", alice.publicKey, alice.privateKey, expected),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects payloads that are well sealed but malformed or from a future version", async () => {
    const sodium = await sodiumReady();
    const seal = (payload: unknown) =>
      toBase64Url(sodium.crypto_box_seal(utf8Encode(JSON.stringify(payload)), alice.publicKey));
    const expected = { type: "vault", id: V1, keyVersion: 1 } as const;
    const key = toBase64Url(await generateKey());
    const base = { v: 1, type: "vault", id: V1, keyVersion: 1, key };

    await expect(
      openSealedKey(await seal({ ...base, v: 2 }), alice.publicKey, alice.privateKey, expected),
    ).rejects.toBeInstanceOf(UnsupportedVersionError);
    await expect(
      openSealedKey(
        await seal({ ...base, key: "AAAA" }),
        alice.publicKey,
        alice.privateKey,
        expected,
      ),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      openSealedKey(await seal("nope"), alice.publicKey, alice.privateKey, expected),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      openSealedKey(await seal(base), alice.publicKey, alice.privateKey, expected),
    ).resolves.toHaveLength(32);
  });

  it("refuses to seal keys of the wrong size", async () => {
    await expect(
      sealKey(alice.publicKey, { type: "vault", id: V1, keyVersion: 1, key: new Uint8Array(16) }),
    ).rejects.toThrow(TypeError);
  });
});
