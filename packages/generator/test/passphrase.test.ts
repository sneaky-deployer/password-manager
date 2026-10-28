import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSPHRASE_OPTIONS,
  EFF_LARGE_WORDLIST,
  GeneratorOptionsError,
  generatePassphrase,
} from "../src/index.ts";

const WORDS = new Set(EFF_LARGE_WORDLIST);

describe("EFF large wordlist", () => {
  it("has 7776 unique words, all lowercase a-z or hyphen", () => {
    expect(EFF_LARGE_WORDLIST).toHaveLength(7776);
    expect(new Set(EFF_LARGE_WORDLIST).size).toBe(7776);
    for (const w of EFF_LARGE_WORDLIST) expect(w).toMatch(/^[a-z-]+$/);
  });
});

describe("generatePassphrase", () => {
  it("defaults to 5 hyphen-separated lowercase words from the list", () => {
    expect(DEFAULT_PASSPHRASE_OPTIONS).toEqual({
      words: 5,
      separator: "-",
      capitalize: false,
      includeNumber: false,
    });
    // Wordlist words may themselves contain hyphens, so check by prefix matching instead of split.
    for (let i = 0; i < 50; i++) {
      const parts = generatePassphrase({ separator: " " }).split(" ");
      expect(parts).toHaveLength(5);
      for (const p of parts) expect(WORDS.has(p)).toBe(true);
    }
  });

  it("honours word count and separators", () => {
    for (const words of [3, 7, 12]) {
      for (const separator of [" ", ".", "_"] as const) {
        const parts = generatePassphrase({ words, separator }).split(separator);
        expect(parts).toHaveLength(words);
        for (const p of parts) expect(WORDS.has(p)).toBe(true);
      }
    }
  });

  it("uses '-' as the default separator", () => {
    const phrase = generatePassphrase();
    expect(phrase).toMatch(/^[a-z-]+$/);
    expect(phrase.split("-").length).toBeGreaterThanOrEqual(5);
  });

  it("puts a single digit between words with the digit separator", () => {
    for (let i = 0; i < 50; i++) {
      const phrase = generatePassphrase({ separator: "digit", words: 6 });
      const parts = phrase.split(/\d/);
      expect(parts).toHaveLength(6);
      expect((phrase.match(/\d/g) ?? []).length).toBe(5);
      for (const p of parts) expect(WORDS.has(p)).toBe(true);
    }
  });

  it("capitalises every word", () => {
    for (let i = 0; i < 50; i++) {
      const parts = generatePassphrase({ capitalize: true, separator: " " }).split(" ");
      for (const p of parts) {
        expect(p.charAt(0)).toMatch(/[A-Z]/);
        expect(WORDS.has(p.charAt(0).toLowerCase() + p.slice(1))).toBe(true);
      }
    }
  });

  it("appends exactly one digit to exactly one word with includeNumber", () => {
    const positions = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const parts = generatePassphrase({ includeNumber: true, separator: " ", words: 4 }).split(
        " ",
      );
      const withDigit = parts.flatMap((p, idx) => (/\d$/.test(p) ? [idx] : []));
      expect(withDigit).toHaveLength(1);
      positions.add(withDigit[0] as number);
      for (const p of parts) {
        expect(WORDS.has(p.replace(/\d$/, ""))).toBe(true);
        expect((p.match(/\d/g) ?? []).length).toBeLessThanOrEqual(1);
      }
    }
    expect(positions.size).toBe(4);
  });

  it("has no digits unless asked for", () => {
    for (let i = 0; i < 50; i++) expect(generatePassphrase()).not.toMatch(/\d/);
  });

  it("throws GeneratorOptionsError for invalid options", () => {
    expect(() => generatePassphrase({ words: 2 })).toThrow(GeneratorOptionsError);
    expect(() => generatePassphrase({ words: 13 })).toThrow(GeneratorOptionsError);
    expect(() => generatePassphrase({ words: 4.5 })).toThrow(GeneratorOptionsError);
    // @ts-expect-error invalid separator on purpose
    expect(() => generatePassphrase({ separator: "," })).toThrow(GeneratorOptionsError);
  });
});
