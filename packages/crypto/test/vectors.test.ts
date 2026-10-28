import { describe, expect, it } from "vitest";
import { sealWithNonce } from "../src/envelope.ts";
import {
  aad,
  derivePasswordKeys,
  deriveRecoveryKeys,
  entropyToRecoveryPhrase,
  fromBase64Url,
  open,
  parseRecoveryPhrase,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";
import vectors from "./vectors.json";

/**
 * Golden vectors. If one of these fails you changed an on-disk format (envelope layout, AAD string,
 * KDF parameter handling or subkey context). Do NOT regenerate them: add a new format version and
 * keep decoding the old one (PLAN.md 9.4 / 21). The values were also cross-checked against an
 * independent implementation (Python: hand-written HChaCha20 + `cryptography` ChaCha20-Poly1305,
 * `cryptography` Argon2id, `hashlib.blake2b` for crypto_kdf).
 */
describe("fixed test vectors", () => {
  const { userId, vaultId, itemId } = vectors.ids;

  it("AAD strings match the contract exactly", () => {
    expect(aad.akPw(userId)).toBe(`pm:v1:ak:pw:${userId}`);
    expect(aad.akRec(userId)).toBe(`pm:v1:ak:rec:${userId}`);
    expect(aad.privateKey(userId)).toBe(`pm:v1:privkey:${userId}`);
    expect(aad.vaultMeta(vaultId, 1)).toBe(`pm:v1:vaultmeta:${vaultId}:1`);
    expect(aad.itemKey(vaultId, itemId, 1)).toBe(`pm:v1:itemkey:${vaultId}:${itemId}:1`);
    expect(aad.item(itemId, 1)).toBe(`pm:v1:item:${itemId}:1`);
    expect(vectors.aad).toEqual({
      akPw: aad.akPw(userId),
      akRec: aad.akRec(userId),
      privateKey: aad.privateKey(userId),
      vaultMeta: aad.vaultMeta(vaultId, 1),
      itemKey: aad.itemKey(vaultId, itemId, 1),
      item: aad.item(itemId, 1),
    });
  });

  it("AAD builders reject components that could forge another string", () => {
    expect(() => aad.item("a:b", 1)).toThrow(TypeError);
    expect(() => aad.item("", 1)).toThrow(TypeError);
    expect(() => aad.item(itemId, 0)).toThrow(TypeError);
    expect(() => aad.item(itemId, 1.5)).toThrow(TypeError);
  });

  it("envelope: fixed key/nonce/AAD/plaintext give the exact string, and it opens", async () => {
    const { key, nonce, plaintext, cases } = vectors.envelope;
    for (const [name, c] of Object.entries(cases)) {
      const envelope = await sealWithNonce(
        fromBase64Url(key),
        fromBase64Url(nonce),
        utf8Encode(plaintext),
        c.aad,
      );
      expect(envelope, name).toBe(c.envelope);
      expect(utf8Decode(await open(fromBase64Url(key), c.envelope, c.aad)), name).toBe(plaintext);
    }
  });

  it("KDF: fixed password/salt/params give the exact authKey and wrapKey", async () => {
    const { password, salt, cases } = vectors.kdf;
    for (const [name, c] of Object.entries(cases)) {
      const keys = await derivePasswordKeys(password, salt, c.kdf as never);
      expect(toBase64Url(keys.authKey), `${name} authKey`).toBe(c.authKey);
      expect(toBase64Url(keys.wrapKey), `${name} wrapKey`).toBe(c.wrapKey);
    }
  });

  it("recovery: fixed entropy gives the exact phrase and subkeys", async () => {
    const { entropy, phrase, recoveryAuthKey, recoveryWrapKey } = vectors.recovery;
    const bytes = fromBase64Url(entropy);
    expect(entropyToRecoveryPhrase(bytes)).toBe(phrase);
    expect(parseRecoveryPhrase(phrase)).toEqual(bytes);
    const keys = await deriveRecoveryKeys(bytes);
    expect(toBase64Url(keys.recoveryAuthKey)).toBe(recoveryAuthKey);
    expect(toBase64Url(keys.recoveryWrapKey)).toBe(recoveryWrapKey);
  });
});
