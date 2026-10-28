import { env, exports } from "cloudflare:workers";
import { SECURITY_HEADERS } from "@pm/shared";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns { ok: true } with the security headers", async () => {
    const res = await exports.default.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("returns a JSON error with security headers for unknown API paths", async () => {
    const res = await exports.default.fetch("https://example.com/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});

describe("environment", () => {
  it("has a local D1 database", async () => {
    const row = await env.DB.prepare("select 1 as one").first<{ one: number }>();
    expect(row?.one).toBe(1);
  });
});
