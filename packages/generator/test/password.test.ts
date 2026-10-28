import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS,
  DEFAULT_PASSWORD_OPTIONS,
  DIGITS,
  GeneratorOptionsError,
  generatePassword,
  LOWERCASE,
  SYMBOLS,
  UPPERCASE,
} from "../src/index.ts";

const ITERATIONS = 300;

describe("generatePassword", () => {
  it("defaults to 20 chars with all sets", () => {
    expect(DEFAULT_PASSWORD_OPTIONS.length).toBe(20);
    const pw = generatePassword();
    expect(pw).toHaveLength(20);
    expect(DEFAULT_PASSWORD_OPTIONS).toMatchObject({
      lowercase: true,
      uppercase: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
    });
  });

  it("honours length across the range", () => {
    for (const length of [8, 9, 20, 64, 127, 128]) {
      expect(generatePassword({ length })).toHaveLength(length);
    }
  });

  it("includes at least one character from every selected set, many times", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const pw = generatePassword({ length: 8 });
      expect([...pw].some((c) => LOWERCASE.includes(c))).toBe(true);
      expect([...pw].some((c) => UPPERCASE.includes(c))).toBe(true);
      expect([...pw].some((c) => DIGITS.includes(c))).toBe(true);
      expect([...pw].some((c) => SYMBOLS.includes(c))).toBe(true);
    }
  });

  it("uses only the selected sets", () => {
    const cases: [Parameters<typeof generatePassword>[0], string][] = [
      [{ uppercase: false, digits: false, symbols: false }, LOWERCASE],
      [{ lowercase: false, digits: false, symbols: false }, UPPERCASE],
      [{ lowercase: false, uppercase: false, symbols: false }, DIGITS],
      [{ lowercase: false, uppercase: false, digits: false }, SYMBOLS],
      [{ symbols: false }, LOWERCASE + UPPERCASE + DIGITS],
      [{ lowercase: false, uppercase: false }, DIGITS + SYMBOLS],
    ];
    for (const [opts, allowed] of cases) {
      for (let i = 0; i < 50; i++) {
        const pw = generatePassword({ ...opts, length: 30 });
        for (const c of pw) expect(allowed).toContain(c);
      }
    }
  });

  it("guarantees each selected set when two sets are chosen", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const pw = generatePassword({ lowercase: false, uppercase: false, length: 8 });
      expect([...pw].some((c) => DIGITS.includes(c))).toBe(true);
      expect([...pw].some((c) => SYMBOLS.includes(c))).toBe(true);
    }
  });

  it("omits ambiguous characters when avoidAmbiguous is set", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const pw = generatePassword({ length: 40, avoidAmbiguous: true });
      for (const c of pw) expect(AMBIGUOUS).not.toContain(c);
    }
  });

  it("can emit ambiguous characters by default", () => {
    const joined = Array.from({ length: 200 }, () => generatePassword({ length: 128 })).join("");
    expect([...AMBIGUOUS].some((c) => joined.includes(c))).toBe(true);
  });

  it("still guarantees every set with ambiguous characters removed", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const pw = generatePassword({ length: 8, avoidAmbiguous: true });
      expect([...pw].some((c) => DIGITS.includes(c))).toBe(true);
      expect([...pw].some((c) => /[a-z]/.test(c))).toBe(true);
    }
  });

  it("is deterministic given an injected source", () => {
    const make = () => {
      let n = 12345;
      return () => {
        n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
        return n;
      };
    };
    expect(generatePassword({}, make())).toBe(generatePassword({}, make()));
  });

  it("throws GeneratorOptionsError for invalid options", () => {
    const bad = [
      { length: 7 },
      { length: 129 },
      { length: 12.5 },
      { length: Number.NaN },
      { lowercase: false, uppercase: false, digits: false, symbols: false },
    ];
    for (const opts of bad) {
      expect(() => generatePassword(opts)).toThrow(GeneratorOptionsError);
    }
    expect(() => generatePassword({ length: 0 })).toThrow(GeneratorOptionsError);
  });
});
