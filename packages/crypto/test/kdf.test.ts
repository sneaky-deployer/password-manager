import { describe, expect, it } from "vitest";
import {
  DEFAULT_KDF,
  derivePasswordKeys,
  InvalidKdfParamsError,
  kdfNeedsUpgrade,
  MIN_KDF_MEM,
  MIN_KDF_OPS,
  toBase64Url,
  validateKdfParams,
} from "../src/index.ts";
import { FAST_KDF } from "./helpers.ts";

const SALT = toBase64Url(new Uint8Array(16).fill(7));

describe("KDF parameters", () => {
  it("exposes the documented defaults and minimums", () => {
    expect(DEFAULT_KDF).toEqual({ alg: "argon2id13", mem: 67108864, ops: 3 });
    expect(MIN_KDF_MEM).toBe(16 * 1024 * 1024);
    expect(MIN_KDF_OPS).toBe(2);
    expect(() => validateKdfParams(DEFAULT_KDF)).not.toThrow();
    expect(() => validateKdfParams(FAST_KDF)).not.toThrow();
  });

  it("rejects weak, absurd and malformed params", () => {
    const bad: unknown[] = [
      { ...FAST_KDF, mem: MIN_KDF_MEM - 1 },
      { ...FAST_KDF, ops: MIN_KDF_OPS - 1 },
      { ...FAST_KDF, mem: 8192 },
      { ...FAST_KDF, mem: 4 * 1024 * 1024 * 1024 },
      { ...FAST_KDF, ops: 1000 },
      { ...FAST_KDF, alg: "argon2i13" },
      { ...FAST_KDF, mem: 1.5 * MIN_KDF_MEM + 0.5 },
      { ...FAST_KDF, ops: "3" },
      null,
      "argon2id13",
    ];
    for (const kdf of bad) {
      expect(() => validateKdfParams(kdf), JSON.stringify(kdf)).toThrow(InvalidKdfParamsError);
    }
  });

  it("derivePasswordKeys refuses weak params before doing any work", async () => {
    await expect(derivePasswordKeys("pw", SALT, { ...FAST_KDF, mem: 8192 })).rejects.toBeInstanceOf(
      InvalidKdfParamsError,
    );
    await expect(derivePasswordKeys("pw", SALT, { ...FAST_KDF, ops: 1 })).rejects.toBeInstanceOf(
      InvalidKdfParamsError,
    );
  });

  it("flags params weaker than the default for silent upgrade", () => {
    expect(kdfNeedsUpgrade(FAST_KDF)).toBe(true);
    expect(kdfNeedsUpgrade(DEFAULT_KDF)).toBe(false);
  });
});

describe("derivePasswordKeys", () => {
  it("is deterministic and yields distinct 32-byte auth and wrap keys", async () => {
    const a = await derivePasswordKeys("pw", SALT, FAST_KDF);
    const b = await derivePasswordKeys("pw", SALT, FAST_KDF);
    expect(a.authKey).toEqual(b.authKey);
    expect(a.wrapKey).toEqual(b.wrapKey);
    expect(a.authKey.length).toBe(32);
    expect(a.wrapKey.length).toBe(32);
    expect(a.authKey).not.toEqual(a.wrapKey);
  });

  it("depends on password, salt and parameters", async () => {
    const base = await derivePasswordKeys("pw", SALT, FAST_KDF);
    const otherPw = await derivePasswordKeys("pw2", SALT, FAST_KDF);
    const otherSalt = await derivePasswordKeys(
      "pw",
      toBase64Url(new Uint8Array(16).fill(8)),
      FAST_KDF,
    );
    const otherOps = await derivePasswordKeys("pw", SALT, { ...FAST_KDF, ops: 3 });
    for (const other of [otherPw, otherSalt, otherOps]) {
      expect(other.authKey).not.toEqual(base.authKey);
      expect(other.wrapKey).not.toEqual(base.wrapKey);
    }
  });

  it("works with the real default parameters", async () => {
    const keys = await derivePasswordKeys("pw", SALT, DEFAULT_KDF);
    expect(keys.authKey.length).toBe(32);
    expect(keys.wrapKey.length).toBe(32);
  });

  it("rejects a salt of the wrong length", async () => {
    await expect(
      derivePasswordKeys("pw", toBase64Url(new Uint8Array(8)), FAST_KDF),
    ).rejects.toThrow(TypeError);
  });
});

describe("password normalisation", () => {
  it("derives the same keys for canonically equivalent passwords (NFKC)", async () => {
    const salt = toBase64Url(new Uint8Array(16).fill(7));
    const composed = await derivePasswordKeys("café ﬁsh", salt, FAST_KDF);
    const decomposed = await derivePasswordKeys("café fish", salt, FAST_KDF);
    expect(toBase64Url(composed.authKey)).toBe(toBase64Url(decomposed.authKey));
    expect(toBase64Url(composed.wrapKey)).toBe(toBase64Url(decomposed.wrapKey));
  });
});
