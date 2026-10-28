import { describe, expect, it } from "vitest";
import {
  GeneratorOptionsError,
  passphraseEntropyBits,
  passwordEntropyBits,
  SYMBOLS,
  strengthFromBits,
} from "../src/index.ts";

describe("passwordEntropyBits", () => {
  it("uses length * log2(pool) with the full 86-symbol pool", () => {
    // 26 + 26 + 10 + 24 symbols = 86 distinct characters.
    expect(SYMBOLS).toHaveLength(24);
    expect(passwordEntropyBits({ length: 20 })).toBeCloseTo(20 * Math.log2(86), 10);
    expect(passwordEntropyBits({ length: 20 })).toBeCloseTo(128.5, 1);
  });

  it("scales with length and pool", () => {
    expect(
      passwordEntropyBits({ length: 10, uppercase: false, digits: false, symbols: false }),
    ).toBeCloseTo(10 * Math.log2(26), 10);
    expect(
      passwordEntropyBits({ length: 8, lowercase: false, uppercase: false, symbols: false }),
    ).toBeCloseTo(8 * Math.log2(10), 10);
  });

  it("shrinks the pool when ambiguous characters are removed", () => {
    // Removes 0 O o 1 l I (6 chars; `|` is not in the symbol set): 80 left.
    expect(passwordEntropyBits({ length: 20, avoidAmbiguous: true })).toBeCloseTo(
      20 * Math.log2(80),
      10,
    );
  });

  it("validates options", () => {
    expect(() => passwordEntropyBits({ length: 3 })).toThrow(GeneratorOptionsError);
  });
});

describe("passphraseEntropyBits", () => {
  it("is words * log2(7776)", () => {
    expect(passphraseEntropyBits({ words: 5 })).toBeCloseTo(5 * Math.log2(7776), 10);
    expect(passphraseEntropyBits({ words: 5 })).toBeCloseTo(64.6, 1);
    expect(passphraseEntropyBits()).toBeCloseTo(64.6, 1);
  });

  it("ignores capitalisation and fixed separators", () => {
    const base = passphraseEntropyBits({ words: 6 });
    expect(passphraseEntropyBits({ words: 6, capitalize: true, separator: "." })).toBe(base);
  });

  it("adds (words - 1) * log2(10) for the digit separator", () => {
    expect(passphraseEntropyBits({ words: 5, separator: "digit" })).toBeCloseTo(
      5 * Math.log2(7776) + 4 * Math.log2(10),
      10,
    );
  });

  it("adds log2(words) + log2(10) for includeNumber", () => {
    expect(passphraseEntropyBits({ words: 4, includeNumber: true })).toBeCloseTo(
      4 * Math.log2(7776) + Math.log2(4) + Math.log2(10),
      10,
    );
  });

  it("validates options", () => {
    expect(() => passphraseEntropyBits({ words: 1 })).toThrow(GeneratorOptionsError);
  });
});

describe("strengthFromBits", () => {
  it("labels the boundaries", () => {
    expect(strengthFromBits(0)).toBe("weak");
    expect(strengthFromBits(49.99)).toBe("weak");
    expect(strengthFromBits(50)).toBe("fair");
    expect(strengthFromBits(79.99)).toBe("fair");
    expect(strengthFromBits(80)).toBe("strong");
    expect(strengthFromBits(99.99)).toBe("strong");
    expect(strengthFromBits(100)).toBe("very-strong");
    expect(strengthFromBits(500)).toBe("very-strong");
  });

  it("matches the default generators", () => {
    expect(strengthFromBits(passphraseEntropyBits({ words: 5 }))).toBe("fair");
    expect(strengthFromBits(passwordEntropyBits({ length: 20 }))).toBe("very-strong");
  });
});
