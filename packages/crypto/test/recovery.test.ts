import { describe, expect, it } from "vitest";
import {
  deriveRecoveryKeys,
  deriveRecoveryKeysFromPhrase,
  entropyToRecoveryPhrase,
  generateRecoveryPhrase,
  InvalidRecoveryPhraseError,
  normalizeRecoveryPhrase,
  parseRecoveryPhrase,
  recoveryAuthKeyFromPhrase,
  toBase64Url,
} from "../src/index.ts";

describe("recovery phrase", () => {
  it("generates 24 distinct-per-call words that parse back to 32 bytes", async () => {
    const a = await generateRecoveryPhrase();
    const b = await generateRecoveryPhrase();
    expect(a.split(" ")).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(parseRecoveryPhrase(a)).toHaveLength(32);
  });

  it("round-trips entropy", () => {
    const entropy = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    expect(parseRecoveryPhrase(entropyToRecoveryPhrase(entropy))).toEqual(entropy);
  });

  it("normalises case and whitespace to the same keys", async () => {
    const phrase = await generateRecoveryPhrase();
    const messy = `  ${phrase.toUpperCase().split(" ").join(" \n\t ")}  `;
    expect(normalizeRecoveryPhrase(messy)).toBe(phrase);
    expect(await recoveryAuthKeyFromPhrase(messy)).toBe(await recoveryAuthKeyFromPhrase(phrase));
  });

  it("rejects a bad checksum", async () => {
    const words = (await generateRecoveryPhrase()).split(" ");
    // Changing the last word to a different valid word almost always breaks the checksum;
    // try a few until one does (a valid word swap has a 1/256 chance of still validating).
    let rejected = 0;
    for (const candidate of ["abandon", "zoo", "legal", "winner"]) {
      if (words[23] === candidate) continue;
      try {
        parseRecoveryPhrase([...words.slice(0, 23), candidate].join(" "));
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRecoveryPhraseError);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThanOrEqual(3);
  });

  it("rejects wrong word counts, unknown words and garbage", async () => {
    const words = (await generateRecoveryPhrase()).split(" ");
    const bad = [
      "",
      "abandon",
      words.slice(0, 12).join(" "),
      words.slice(0, 23).join(" "),
      [...words, "abandon"].join(" "),
      [...words.slice(0, 23), "notaword"].join(" "),
      "not a recovery phrase at all",
    ];
    for (const phrase of bad) {
      expect(() => parseRecoveryPhrase(phrase), phrase).toThrow(InvalidRecoveryPhraseError);
    }
  });

  it("rejects a valid 12-word BIP39 phrase (we require 32 bytes of entropy)", () => {
    const twelve = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(() => parseRecoveryPhrase(twelve)).toThrow(InvalidRecoveryPhraseError);
  });

  it("derives distinct auth and wrap keys", async () => {
    const keys = await deriveRecoveryKeysFromPhrase(await generateRecoveryPhrase());
    expect(keys.recoveryAuthKey).toHaveLength(32);
    expect(keys.recoveryWrapKey).toHaveLength(32);
    expect(keys.recoveryAuthKey).not.toEqual(keys.recoveryWrapKey);
  });

  it("different entropy gives different keys", async () => {
    const a = await deriveRecoveryKeys(new Uint8Array(32).fill(1));
    const b = await deriveRecoveryKeys(new Uint8Array(32).fill(2));
    expect(toBase64Url(a.recoveryAuthKey)).not.toBe(toBase64Url(b.recoveryAuthKey));
  });
});
