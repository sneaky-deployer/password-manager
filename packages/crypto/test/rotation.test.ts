import { describe, expect, it } from "vitest";
import {
  createEncryptedItem,
  DecryptionError,
  decryptItem,
  decryptVaultMeta,
  encryptVaultMeta,
  generateKey,
  reencryptItem,
  rotateVaultKey,
  unwrapItemKey,
} from "../src/index.ts";
import { I1, I2, V1 } from "./helpers.ts";

async function seedVault() {
  const vk = await generateKey();
  const encryptedMeta = await encryptVaultMeta(vk, V1, 1, { name: "Shared", color: "#00f" });
  const contents = {
    [I1]: { title: "one", password: "p1" },
    [I2]: { title: "two", password: "p2" },
  };
  const a = await createEncryptedItem({
    vk,
    vaultId: V1,
    vaultKeyVersion: 1,
    itemId: I1,
    content: contents[I1],
  });
  const b = await createEncryptedItem({
    vk,
    vaultId: V1,
    vaultKeyVersion: 1,
    itemId: I2,
    content: contents[I2],
  });
  return { vk, encryptedMeta, contents, items: [a, b] };
}

describe("key rotation", () => {
  it("rotates VK and every IK, bumping versions, with everything decryptable under the new keys", async () => {
    const { vk, encryptedMeta, contents, items } = await seedVault();
    const rotated = await rotateVaultKey({
      vaultId: V1,
      oldVk: vk,
      oldKeyVersion: 1,
      encryptedMeta,
      items: items.map((i) => i.wire),
    });

    expect(rotated.newKeyVersion).toBe(2);
    expect(rotated.newVk).not.toEqual(vk);
    expect(await decryptVaultMeta(rotated.newVk, V1, 2, rotated.encryptedMeta)).toEqual({
      name: "Shared",
      color: "#00f",
    });
    expect(rotated.items).toHaveLength(2);

    for (const [index, item] of rotated.items.entries()) {
      const old = items[index];
      expect(old).toBeDefined();
      const { wire, ik } = item;
      expect(wire.id).toBe(old?.wire.id);
      expect(wire.vaultId).toBe(V1);
      expect(wire.vaultKeyVersion).toBe(2);
      expect(wire.itemKeyVersion).toBe(2);
      expect(ik).not.toEqual(old?.ik);
      const unwrapped = await unwrapItemKey(rotated.newVk, V1, wire.id, 2, wire.wrappedKey);
      expect(unwrapped).toEqual(ik);
      expect(await decryptItem(unwrapped, wire.id, 2, wire.encryptedData)).toEqual(
        contents[wire.id as keyof typeof contents],
      );
    }
  });

  it("old keys and old versions no longer open the rotated data", async () => {
    const { vk, encryptedMeta, items } = await seedVault();
    const rotated = await rotateVaultKey({
      vaultId: V1,
      oldVk: vk,
      oldKeyVersion: 1,
      encryptedMeta,
      items: items.map((i) => i.wire),
    });
    const first = rotated.items[0];
    const oldFirst = items[0];
    expect(first && oldFirst).toBeTruthy();
    if (!first || !oldFirst) return;

    await expect(decryptVaultMeta(vk, V1, 2, rotated.encryptedMeta)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptVaultMeta(vk, V1, 1, rotated.encryptedMeta)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(unwrapItemKey(vk, V1, I1, 2, first.wire.wrappedKey)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(unwrapItemKey(vk, V1, I1, 1, first.wire.wrappedKey)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptItem(oldFirst.ik, I1, 2, first.wire.encryptedData)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptItem(oldFirst.ik, I1, 1, first.wire.encryptedData)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("is all-or-nothing when an item cannot be decrypted", async () => {
    const { vk, encryptedMeta, items } = await seedVault();
    const [a, b] = items;
    if (!a || !b) throw new Error("seed failed");
    const broken = { ...b.wire, encryptedData: a.wire.encryptedData };
    await expect(
      rotateVaultKey({
        vaultId: V1,
        oldVk: vk,
        oldKeyVersion: 1,
        encryptedMeta,
        items: [a.wire, broken],
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("reencryptItem can rotate only the item key (item-share revoke)", async () => {
    const { vk, items } = await seedVault();
    const first = items[0];
    expect(first).toBeDefined();
    if (!first) return;
    const next = await reencryptItem({
      vaultId: V1,
      item: first.wire,
      oldVk: vk,
      oldVaultKeyVersion: 1,
      newVk: vk,
      newVaultKeyVersion: 1,
    });
    expect(next.wire.vaultKeyVersion).toBe(1);
    expect(next.wire.itemKeyVersion).toBe(2);
    expect(next.ik).not.toEqual(first.ik);
    expect(await decryptItem(next.ik, I1, 2, next.wire.encryptedData)).toEqual({
      title: "one",
      password: "p1",
    });
    await expect(decryptItem(first.ik, I1, 2, next.wire.encryptedData)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("handles an empty vault", async () => {
    const vk = await generateKey();
    const rotated = await rotateVaultKey({
      vaultId: V1,
      oldVk: vk,
      oldKeyVersion: 4,
      encryptedMeta: await encryptVaultMeta(vk, V1, 4, { name: "Empty" }),
      items: [],
    });
    expect(rotated.newKeyVersion).toBe(5);
    expect(rotated.items).toEqual([]);
  });
});
