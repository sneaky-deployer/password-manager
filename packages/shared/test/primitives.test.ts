import { describe, expect, it } from "vitest";
import {
  base64urlBytes,
  base64urlLength,
  base64urlSchema,
  emailSchema,
  envelopeSchema,
  kdfParamsSchema,
  MIN_ENVELOPE_CHARS,
  sealedBoxSchema,
  timestampSchema,
  uuidSchema,
} from "../src/index.ts";
import { envelope, rand, sealedBox } from "./fixtures.ts";

describe("base64url", () => {
  it("accepts unpadded base64url and rejects everything else", () => {
    expect(base64urlSchema.safeParse("abcd_-AZ09").success).toBe(true);
    expect(base64urlSchema.safeParse("abcd+/").success).toBe(false);
    expect(base64urlSchema.safeParse("abcd==").success).toBe(false);
    expect(base64urlSchema.safeParse("").success).toBe(false);
    expect(base64urlSchema.safeParse("abcde").success).toBe(false); // length 1 mod 4
  });

  it("computes encoded lengths", () => {
    expect(base64urlLength(32)).toBe(43);
    expect(base64urlLength(16)).toBe(22);
    expect(base64urlLength(24)).toBe(32);
    expect(base64urlLength(41)).toBe(55);
  });

  it("enforces exact byte lengths", () => {
    expect(base64urlBytes(32).safeParse(rand(32)).success).toBe(true);
    expect(base64urlBytes(32).safeParse(rand(31)).success).toBe(false);
    expect(base64urlBytes(32).safeParse(rand(33)).success).toBe(false);
    expect(base64urlBytes(16).safeParse(rand(16)).success).toBe(true);
    expect(base64urlBytes(16).safeParse(rand(32)).success).toBe(false);
    expect(rand(32)).toHaveLength(43);
    expect(rand(16)).toHaveLength(22);
  });
});

describe("uuidSchema", () => {
  it("accepts lowercase v4 only", () => {
    expect(uuidSchema.safeParse(crypto.randomUUID()).success).toBe(true);
    expect(uuidSchema.safeParse(crypto.randomUUID().toUpperCase()).success).toBe(false);
    expect(uuidSchema.safeParse("00000000-0000-1000-8000-000000000000").success).toBe(false); // v1
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("emailSchema", () => {
  it("trims and lowercases", () => {
    expect(emailSchema.parse("  Owner@Example.COM ")).toBe("owner@example.com");
  });

  it("rejects invalid and overlong addresses", () => {
    expect(emailSchema.safeParse("nope").success).toBe(false);
    expect(emailSchema.safeParse("a@b").success).toBe(false);
    expect(emailSchema.safeParse(`${"a".repeat(250)}@example.com`).success).toBe(false);
    expect(emailSchema.safeParse(123).success).toBe(false);
  });
});

describe("timestampSchema", () => {
  it("accepts integer milliseconds only", () => {
    expect(timestampSchema.safeParse(1_700_000_000_000).success).toBe(true);
    expect(timestampSchema.safeParse(1.5).success).toBe(false);
    expect(timestampSchema.safeParse(-1).success).toBe(false);
    expect(timestampSchema.safeParse("1").success).toBe(false);
  });
});

describe("kdfParamsSchema", () => {
  const ok = { alg: "argon2id13", mem: 64 * 1024 * 1024, ops: 3 };

  it("accepts the defaults and the bounds", () => {
    expect(kdfParamsSchema.safeParse(ok).success).toBe(true);
    expect(kdfParamsSchema.safeParse({ ...ok, mem: 16 * 1024 * 1024, ops: 2 }).success).toBe(true);
    expect(kdfParamsSchema.safeParse({ ...ok, mem: 1024 * 1024 * 1024, ops: 16 }).success).toBe(
      true,
    );
  });

  it("rejects weak, huge, unknown and extra parameters", () => {
    expect(kdfParamsSchema.safeParse({ ...ok, mem: 16 * 1024 * 1024 - 1 }).success).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...ok, mem: 1024 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...ok, ops: 1 }).success).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...ok, ops: 17 }).success).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...ok, alg: "pbkdf2" }).success).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("envelope and sealed box", () => {
  it("enforces the 41 byte minimum", () => {
    expect(MIN_ENVELOPE_CHARS).toBe(55);
    expect(envelopeSchema.safeParse(rand(41)).success).toBe(true);
    expect(envelopeSchema.safeParse(rand(40)).success).toBe(false);
    expect(envelopeSchema.safeParse(envelope(32)).success).toBe(true);
  });

  it("enforces the maximum", () => {
    expect(envelopeSchema.safeParse(rand(64 * 1024 + 41)).success).toBe(true);
    expect(envelopeSchema.safeParse(rand(80 * 1024)).success).toBe(false);
  });

  it("validates sealed boxes", () => {
    expect(sealedBoxSchema.safeParse(sealedBox()).success).toBe(true);
    expect(sealedBoxSchema.safeParse(rand(32)).success).toBe(false);
  });
});
