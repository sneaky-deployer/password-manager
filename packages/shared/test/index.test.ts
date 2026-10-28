import { describe, expect, it } from "vitest";
import { healthResponseSchema, PACKAGE_NAME } from "../src/index.ts";

describe("@pm/shared", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@pm/shared");
  });

  it("validates the health response", () => {
    expect(healthResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(healthResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});
