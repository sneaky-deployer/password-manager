import { beforeEach, describe, expect, it } from "vitest";
import { readJson, request, resetDb, TEST_ORIGIN } from "./helpers.ts";

// /api/nope does not exist: reaching its 404 proves the request got past the origin check.
describe("originCheck", () => {
  beforeEach(resetDb);

  it("rejects a POST without an Origin header", async () => {
    const res = await request("POST", "/api/nope", { origin: null, json: {} });
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ error: { code: "forbidden" } });
  });

  it.each([
    "https://evil.example",
    "https://azzaz.dev", // a sibling "same-site" origin
    `${TEST_ORIGIN}.evil.example`,
    `${TEST_ORIGIN}/`,
    "null",
  ])("rejects a POST from %s", async (origin) => {
    const res = await request("POST", "/api/nope", { origin, json: {} });
    expect(res.status).toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects %s with the wrong Origin",
    async (method) => {
      const res = await request(method, "/api/nope", { origin: "https://evil.example" });
      expect(res.status).toBe(403);
    },
  );

  it("lets a POST with the exact Origin through", async () => {
    const res = await request("POST", "/api/nope", { origin: TEST_ORIGIN, json: {} });
    expect(res.status).toBe(404);
  });

  it("does not require an Origin on GET", async () => {
    const res = await request("GET", "/api/nope");
    expect(res.status).toBe(404);
  });

  it("serves GET /api/health without an Origin", async () => {
    expect((await request("GET", "/api/health")).status).toBe(200);
  });

  it("keeps the security headers on rejections", async () => {
    const res = await request("POST", "/api/nope", { origin: null });
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
