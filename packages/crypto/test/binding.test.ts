import { describe, expect, it } from "vitest";
import {
  createEncryptedItem,
  DecryptionError,
  decryptItem,
  decryptVaultMeta,
  encryptItem,
  encryptVaultMeta,
  generateKey,
  ItemTooLargeError,
  MAX_ITEM_PLAINTEXT_BYTES,
  unwrapItemKey,
  wrapItemKey,
} from "../src/index.ts";
import { I1, I2, V1, V2 } from "./helpers.ts";

describe("ciphertext binding (AAD)", () => {
  it("item encrypted for id A cannot be decrypted as id B or at another key version", async () => {
    const ik = await generateKey();
    const enc = await encryptItem(ik, I1, 1, { title: "a" });
    expect(await decryptItem(ik, I1, 1, enc)).toEqual({ title: "a" });
    await expect(decryptItem(ik, I2, 1, enc)).rejects.toBeInstanceOf(DecryptionError);
    await expect(decryptItem(ik, I1, 2, enc)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("wrapped item key is bound to vault id, item id and vault key version", async () => {
    const vk = await generateKey();
    const ik = await generateKey();
    const wrapped = await wrapItemKey(vk, V1, I1, 1, ik);
    expect(await unwrapItemKey(vk, V1, I1, 1, wrapped)).toEqual(ik);
    await expect(unwrapItemKey(vk, V2, I1, 1, wrapped)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapItemKey(vk, V1, I2, 1, wrapped)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapItemKey(vk, V1, I1, 2, wrapped)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapItemKey(await generateKey(), V1, I1, 1, wrapped)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("vault metadata is bound to vault id and key version", async () => {
    const vk = await generateKey();
    const enc = await encryptVaultMeta(vk, V1, 1, {
      name: "Work",
      icon: "briefcase",
      color: "#fff",
    });
    expect(await decryptVaultMeta(vk, V1, 1, enc)).toEqual({
      name: "Work",
      icon: "briefcase",
      color: "#fff",
    });
    await expect(decryptVaultMeta(vk, V2, 1, enc)).rejects.toBeInstanceOf(DecryptionError);
    await expect(decryptVaultMeta(vk, V1, 2, enc)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("a wrapped item key cannot be passed off as item content or vice versa", async () => {
    const vk = await generateKey();
    const { ik, wire } = await createEncryptedItem({
      vk,
      vaultId: V1,
      vaultKeyVersion: 1,
      itemId: I1,
      content: { x: 1 },
    });
    await expect(decryptItem(vk, I1, 1, wire.wrappedKey)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapItemKey(ik, V1, I1, 1, wire.encryptedData)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("enforces the 64 KiB plaintext limit on encrypt", async () => {
    const ik = await generateKey();
    // {"v":"..."} adds 8 bytes of JSON syntax.
    const fits = { v: "a".repeat(MAX_ITEM_PLAINTEXT_BYTES - 8) };
    const tooBig = { v: "a".repeat(MAX_ITEM_PLAINTEXT_BYTES - 7) };
    await expect(encryptItem(ik, I1, 1, fits)).resolves.toBeTypeOf("string");
    await expect(encryptItem(ik, I1, 1, tooBig)).rejects.toBeInstanceOf(ItemTooLargeError);
    // The limit is on UTF-8 bytes, not characters.
    await expect(
      encryptItem(ik, I1, 1, { v: "é".repeat(MAX_ITEM_PLAINTEXT_BYTES / 2) }),
    ).rejects.toBeInstanceOf(ItemTooLargeError);
  });

  it("rejects content that is not JSON-serialisable", async () => {
    await expect(encryptItem(await generateKey(), I1, 1, undefined)).rejects.toThrow(TypeError);
  });
});
