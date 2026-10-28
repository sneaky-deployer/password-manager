import { describe, expect, it } from "vitest";
import { healthResponseSchema, PACKAGE_NAME, SECURITY_HEADERS } from "../src/index.ts";

describe("@pm/shared", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@pm/shared");
  });

  it("validates the health response", () => {
    expect(healthResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(healthResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it("still exports the security headers", () => {
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
});
