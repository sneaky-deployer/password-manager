import { userLookupResponseSchema } from "@pm/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDb, signedInClient } from "./helpers.ts";
import { body, parseWith } from "./vault-helpers.ts";

describe("GET /api/users/lookup", () => {
  beforeEach(resetDb);

  it("returns id, email and public key of an active user", async () => {
    const { client } = await signedInClient();
    const target = await createUser({ email: "target@example.test" });
    const res = await client.get("/api/users/lookup?email=Target@Example.test");
    expect(res.status).toBe(200);
    const parsed = parseWith(userLookupResponseSchema, await body(res));
    expect(parsed).toEqual({
      userId: target.id,
      email: "target@example.test",
      publicKey: target.publicKey,
    });
  });

  it("answers 404 for unknown and disabled users alike, with no extra information", async () => {
    const { client } = await signedInClient();
    await createUser({ email: "off@example.test", status: "disabled" });
    const unknown = await client.get("/api/users/lookup?email=nobody@example.test");
    const disabled = await client.get("/api/users/lookup?email=off@example.test");
    expect(unknown.status).toBe(404);
    expect(disabled.status).toBe(404);
    expect(await body(unknown)).toEqual(await body(disabled));
  });

  it("requires a session and a valid email", async () => {
    const { client } = await signedInClient();
    const anonymous = await signedInClient();
    anonymous.client.jar.clear();
    expect((await anonymous.client.get("/api/users/lookup?email=a@example.test")).status).toBe(401);
    expect((await client.get("/api/users/lookup")).status).toBe(400);
    expect((await client.get("/api/users/lookup?email=not-an-email")).status).toBe(400);
  });

  it("is limited to 30 lookups per 15 minutes per user", async () => {
    const { client } = await signedInClient();
    const other = await signedInClient();
    for (let i = 0; i < 30; i++) {
      const res = await client.get("/api/users/lookup?email=nobody@example.test");
      expect(res.status).toBe(404);
    }
    const limited = await client.get("/api/users/lookup?email=nobody@example.test");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
    // Another user has their own budget.
    expect((await other.client.get("/api/users/lookup?email=nobody@example.test")).status).toBe(
      404,
    );
  });
});
