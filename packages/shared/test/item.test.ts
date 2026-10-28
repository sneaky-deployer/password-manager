import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  ERROR_CODES,
  itemContentSchema,
  MAX_ITEM_PLAINTEXT_BYTES,
  sealedKeyPayloadSchema,
  vaultMetaSchema,
} from "../src/index.ts";
import { rand, uuid } from "./fixtures.ts";

describe("itemContentSchema", () => {
  it("accepts a full login and applies list defaults", () => {
    const full = {
      type: "login",
      name: "GitHub",
      username: "octocat",
      password: "hunter2",
      urls: ["https://github.com/login"],
      totp: "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      notes: "work account",
      customFields: [{ label: "PIN", value: "1234", hidden: true }],
      passwordUpdatedAt: 1_700_000_000_000,
    };
    expect(itemContentSchema.parse(full)).toEqual(full);

    const minimal = itemContentSchema.parse({ type: "login", name: "Bare" });
    expect(minimal).toEqual({ type: "login", name: "Bare", urls: [], customFields: [] });
  });

  it("accepts a note", () => {
    expect(itemContentSchema.parse({ type: "note", name: "Wi-Fi", notes: "pw: x" })).toEqual({
      type: "note",
      name: "Wi-Fi",
      notes: "pw: x",
    });
  });

  it("rejects unknown types and unknown keys", () => {
    expect(itemContentSchema.safeParse({ type: "card", name: "Visa" }).success).toBe(false);
    expect(itemContentSchema.safeParse({ name: "no type" }).success).toBe(false);
    expect(itemContentSchema.safeParse({ type: "note", name: "n", notes: "", x: 1 }).success).toBe(
      false,
    );
    expect(itemContentSchema.safeParse({ type: "login", name: "n", notes2: "" }).success).toBe(
      false,
    );
  });

  it("enforces field limits", () => {
    const login = (extra: Record<string, unknown>) =>
      itemContentSchema.safeParse({ type: "login", name: "n", ...extra }).success;

    expect(login({})).toBe(true);
    expect(itemContentSchema.safeParse({ type: "login", name: "" }).success).toBe(false);
    expect(itemContentSchema.safeParse({ type: "login", name: "a".repeat(201) }).success).toBe(
      false,
    );
    expect(itemContentSchema.safeParse({ type: "login", name: "a".repeat(200) }).success).toBe(
      true,
    );
    expect(login({ urls: Array.from({ length: 20 }, () => "https://a.example") })).toBe(true);
    expect(login({ urls: Array.from({ length: 21 }, () => "https://a.example") })).toBe(false);
    expect(login({ notes: "a".repeat(10_000) })).toBe(true);
    expect(login({ notes: "a".repeat(10_001) })).toBe(false);
    const field = { label: "l", value: "v", hidden: false };
    expect(login({ customFields: Array.from({ length: 50 }, () => field) })).toBe(true);
    expect(login({ customFields: Array.from({ length: 51 }, () => field) })).toBe(false);
    expect(login({ customFields: [{ label: "l", value: "v" }] })).toBe(false);
    expect(login({ passwordUpdatedAt: 1.5 })).toBe(false);
  });

  it("enforces the 64 KiB serialized size", () => {
    const big = {
      type: "login",
      name: "big",
      customFields: Array.from({ length: 10 }, () => ({
        label: "l",
        value: "😀".repeat(2_500), // 4 bytes each in UTF-8, under the 10k char field cap
        hidden: false,
      })),
    };
    const result = itemContentSchema.safeParse(big);
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(
      MAX_ITEM_PLAINTEXT_BYTES,
    );
    expect(result.success).toBe(false);
  });
});

describe("vault meta and sealed key payload", () => {
  it("validates vault metadata", () => {
    expect(vaultMetaSchema.parse({ name: "Personal", icon: "home", color: "#3366ff" })).toEqual({
      name: "Personal",
      icon: "home",
      color: "#3366ff",
    });
    expect(vaultMetaSchema.safeParse({ name: "" }).success).toBe(false);
    expect(vaultMetaSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });

  it("validates sealed key payloads", () => {
    const payload = { v: 1, type: "vault", id: uuid(), keyVersion: 3, key: rand(32) };
    expect(sealedKeyPayloadSchema.parse(payload)).toEqual(payload);
    expect(sealedKeyPayloadSchema.safeParse({ ...payload, v: 2 }).success).toBe(false);
    expect(sealedKeyPayloadSchema.safeParse({ ...payload, type: "user" }).success).toBe(false);
    expect(sealedKeyPayloadSchema.safeParse({ ...payload, key: rand(16) }).success).toBe(false);
    expect(sealedKeyPayloadSchema.safeParse({ ...payload, keyVersion: 0 }).success).toBe(false);
  });
});

describe("errors", () => {
  it("parses an API error body", () => {
    const body = { error: { code: "revision_conflict", message: "Stale", details: { r: 3 } } };
    expect(apiErrorSchema.parse(body)).toEqual(body);
    expect(apiErrorSchema.safeParse({ error: { code: "nope", message: "x" } }).success).toBe(false);
    expect(ERROR_CODES.last_admin).toBe("last_admin");
  });
});
