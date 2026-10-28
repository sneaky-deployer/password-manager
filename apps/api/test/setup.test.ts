import { apiErrorSchema, apiPaths, okResponseSchema, setupStatusResponseSchema } from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { invites } from "../src/db/schema.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { getDevOutbox } from "../src/lib/email.ts";
import { latestInviteToken } from "./account-test-utils.ts";
import { createClient, createUser, db, readJson, resetDb } from "./helpers.ts";

const ADMIN_EMAIL = "owner@example.test";

describe("setup (PLAN.md 10.0)", () => {
  beforeEach(resetDb);

  it("reports needsSetup while no admin exists", async () => {
    const client = createClient();
    const res = await client.get(apiPaths.setup.status);
    expect(res.status).toBe(200);
    expect(setupStatusResponseSchema.parse(await readJson(res))).toEqual({ needsSetup: true });

    // A plain user is not an admin: setup stays available.
    await createUser({ role: "user" });
    expect(
      setupStatusResponseSchema.parse(await readJson(await client.get(apiPaths.setup.status))),
    ).toEqual({ needsSetup: true });
  });

  it("emails an admin invite to ADMIN_EMAIL with a fragment link", async () => {
    const client = createClient();
    const res = await client.post(apiPaths.setup.start);
    expect(res.status).toBe(200);
    expect(okResponseSchema.parse(await readJson(res))).toEqual({ ok: true });

    const outbox = getDevOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(ADMIN_EMAIL);
    const token = latestInviteToken(ADMIN_EMAIL);
    expect(outbox[0]?.text).toContain(`https://pm.test/invite#t=${token}`);

    // Only the hash is stored.
    const rows = await db.select().from(invites).where(eq(invites.email, ADMIN_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "admin", kind: "new_account", invitedBy: null });
    expect(rows[0]?.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("replaces the earlier setup invite so only the newest link works", async () => {
    const client = createClient();
    await client.post(apiPaths.setup.start);
    const first = latestInviteToken(ADMIN_EMAIL);
    await client.post(apiPaths.setup.start);
    const second = latestInviteToken(ADMIN_EMAIL);
    expect(second).not.toBe(first);
    expect(await db.select().from(invites)).toHaveLength(1);

    const stale = await client.post(apiPaths.invites.inspect, { token: first });
    expect(stale.status).toBe(410);
    const fresh = await client.post(apiPaths.invites.inspect, { token: second });
    expect(fresh.status).toBe(200);
  });

  it("is rate limited to 3 per hour", async () => {
    const client = createClient();
    for (let i = 0; i < 3; i++) {
      expect((await client.post(apiPaths.setup.start)).status).toBe(200);
    }
    const res = await client.post(apiPaths.setup.start);
    expect(res.status).toBe(429);
    expect(apiErrorSchema.parse(await readJson(res)).error.code).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("is only available until an admin exists", async () => {
    await createUser({ role: "admin" });
    const client = createClient();

    const status = await client.get(apiPaths.setup.status);
    expect(setupStatusResponseSchema.parse(await readJson(status))).toEqual({ needsSetup: false });

    const start = await client.post(apiPaths.setup.start);
    expect(start.status).toBe(404);
    expect(apiErrorSchema.parse(await readJson(start)).error.code).toBe("setup_not_available");
    expect(getDevOutbox()).toHaveLength(0);
  });

  it("rejects a body on setup/start", async () => {
    const res = await createClient().post(apiPaths.setup.start, { email: "x@example.test" });
    expect(res.status).toBe(400);
  });
});
