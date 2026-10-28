import {
  apiErrorSchema,
  apiPaths,
  backupCodesResponseSchema,
  listPasskeysResponseSchema,
  loginOkResponseSchema,
  meResponseSchema,
  okResponseSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
  twoFactorRequiredResponseSchema,
  twoFactorVerifyResponseSchema,
  webauthnOptionsResponseSchema,
  webauthnRegisterOptionsResponseSchema,
  webauthnRegisterVerifyResponseSchema,
} from "@pm/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  authChallenges,
  backupCodes,
  users,
  webauthnCredentials,
} from "../src/db/schema.ts";
import { aesGcmDecryptToString } from "../src/lib/crypto.ts";
import {
  config,
  createKnownUser,
  emailsTo,
  enableTotp,
  type KnownUser,
  loginAs,
  regenerateBackupCodes,
  totpCode,
} from "./account-test-utils.ts";
import { createClient, db, readJson, resetDb, type TestClient } from "./helpers.ts";
import { VirtualAuthenticator } from "./virtual-authenticator.ts";

const ORIGIN = "https://pm.test";

/** First login step; returns the challenge token and the offered methods. */
async function startLogin(known: KnownUser) {
  const res = await createClient().post(apiPaths.auth.login, {
    email: known.user.email,
    authKey: known.authKey,
  });
  expect(res.status).toBe(200);
  return twoFactorRequiredResponseSchema.parse(await readJson(res));
}

async function verify(
  challengeToken: string,
  body: Record<string, unknown>,
  client = createClient(),
) {
  const res = await client.post(apiPaths.auth.twoFactorVerify, { challengeToken, ...body });
  return { res, client };
}

describe("TOTP setup and enable (PLAN.md 10.6)", () => {
  beforeEach(resetDb);

  it("stores the secret encrypted, only after a confirmed code, and returns backup codes once", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);

    const setupRes = await client.post(apiPaths.me.totpSetup);
    expect(setupRes.status).toBe(200);
    const setup = totpSetupResponseSchema.parse(await readJson(setupRes));
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);

    // Pending: nothing on the user row yet, 2FA still off.
    let row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row?.totpSecretEnc).toBeNull();
    const pending = await db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.userId, known.user.id));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).not.toContain(setup.secret);

    // A wrong code is rejected and changes nothing.
    const wrong = await client.post(apiPaths.me.totpEnable, {
      code: "000000" === totpCode(setup.secret) ? "111111" : "000000",
    });
    expect(wrong.status).toBe(401);
    expect(apiErrorSchema.parse(await readJson(wrong)).error.code).toBe("invalid_two_factor");

    const enable = await client.post(apiPaths.me.totpEnable, { code: totpCode(setup.secret) });
    expect(enable.status).toBe(200);
    const { backupCodes: codes } = totpEnableResponseSchema.parse(await readJson(enable));
    expect(codes).toHaveLength(10);

    row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row?.totpSecretEnc).toBeTruthy();
    expect(row?.totpSecretEnc).not.toContain(setup.secret);
    expect(
      await aesGcmDecryptToString(
        config().serverEncKey,
        row?.totpSecretEnc ?? "",
        `pm:totp:${known.user.id}`,
      ),
    ).toBe(setup.secret);
    expect(row?.totpLastStep).toBeGreaterThan(0);
    expect(
      await db.select().from(authChallenges).where(eq(authChallenges.userId, known.user.id)),
    ).toHaveLength(0);

    // Backup codes are stored hashed.
    const stored = await db.select().from(backupCodes).where(eq(backupCodes.userId, known.user.id));
    expect(stored).toHaveLength(10);
    for (const code of codes ?? []) expect(stored.map((s) => s.codeHash)).not.toContain(code);

    const me = meResponseSchema.parse(await readJson(await client.get(apiPaths.me.root)));
    expect(me.user.twoFactor).toEqual({ totp: true, webauthn: 0 });

    // Security notice + audit.
    expect(emailsTo(known.user.email).some((m) => m.subject.startsWith("Security notice"))).toBe(
      true,
    );
    const events = await db.select().from(auditEvents).where(eq(auditEvents.userId, known.user.id));
    expect(events.map((e) => e.event)).toContain("2fa_enabled");
  });

  it("refuses to enable without a pending setup and to set up twice", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const early = await client.post(apiPaths.me.totpEnable, { code: "123456" });
    expect(early.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(early)).error.code).toBe("challenge_invalid");

    await enableTotp(client);
    const again = await client.post(apiPaths.me.totpSetup);
    expect(again.status).toBe(409);
  });

  it("a second setup replaces the pending secret", async () => {
    const { client } = await loginAs(await createKnownUser());
    const first = totpSetupResponseSchema.parse(
      await readJson(await client.post(apiPaths.me.totpSetup)),
    );
    const second = totpSetupResponseSchema.parse(
      await readJson(await client.post(apiPaths.me.totpSetup)),
    );
    expect(second.secret).not.toBe(first.secret);
    const oldCode = await client.post(apiPaths.me.totpEnable, { code: totpCode(first.secret) });
    expect(oldCode.status).toBe(401);
    const newCode = await client.post(apiPaths.me.totpEnable, { code: totpCode(second.secret) });
    expect(newCode.status).toBe(200);
  });

  it("requires a session", async () => {
    expect((await createClient().post(apiPaths.me.totpSetup)).status).toBe(401);
  });
});

describe("login with TOTP", () => {
  beforeEach(resetDb);

  it("completes the login with a valid code and rejects replay of the same code", async () => {
    const known = await createKnownUser();
    const { client: setupClient } = await loginAs(known);
    const { secret } = await enableTotp(setupClient);

    // enableTotp used the current step, so the same code is a replay now.
    const replayChallenge = await startLogin(known);
    const replay = await verify(replayChallenge.challengeToken, {
      method: "totp",
      code: totpCode(secret),
    });
    expect(replay.res.status).toBe(401);
    expect(apiErrorSchema.parse(await readJson(replay.res)).error.code).toBe("invalid_two_factor");

    // An older step is also refused; the next step works (clock drift window of one step).
    const olderChallenge = await startLogin(known);
    const older = await verify(olderChallenge.challengeToken, {
      method: "totp",
      code: totpCode(secret, Date.now() - 30_000),
    });
    expect(older.res.status).toBe(401);

    const challenge = await startLogin(known);
    const next = totpCode(secret, Date.now() + 30_000);
    const ok = await verify(challenge.challengeToken, { method: "totp", code: next });
    expect(ok.res.status).toBe(200);
    const body = twoFactorVerifyResponseSchema.parse(await readJson(ok.res));
    expect(body.user.id).toBe(known.user.id);
    expect(body.keys.userId).toBe(known.user.id);
    expect(ok.res.headers.get("Set-Cookie")).toContain("pm_session=");
    expect((await ok.client.get(apiPaths.me.root)).status).toBe(200);

    // The challenge is single use.
    const again = await verify(challenge.challengeToken, {
      method: "totp",
      code: totpCode(secret, Date.now() + 60_000),
    });
    expect(again.res.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(again.res)).error.code).toBe("challenge_invalid");

    const events = await db.select().from(auditEvents).where(eq(auditEvents.userId, known.user.id));
    const logins = events.filter((e) => e.event === "login");
    expect(logins).toHaveLength(2); // the setup client's password login and this one
    expect(logins.map((e) => JSON.parse(e.meta).method).sort()).toEqual(["password", "totp"]);
  });

  it("rejects wrong codes, bad tokens and counts failures (10 then 429)", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { secret } = await enableTotp(client);
    const challenge = await startLogin(known);
    const wrongCode = totpCode(secret, Date.now() + 10 * 30_000);

    const badToken = await verify("A".repeat(43), { method: "totp", code: wrongCode });
    expect(badToken.res.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(badToken.res)).error.code).toBe("challenge_invalid");

    for (let i = 0; i < 10; i++) {
      const res = (await verify(challenge.challengeToken, { method: "totp", code: wrongCode })).res;
      expect(res.status).toBe(401);
    }
    const blocked = await verify(challenge.challengeToken, {
      method: "totp",
      code: totpCode(secret, Date.now() + 30_000),
    });
    expect(blocked.res.status).toBe(429);
    expect(apiErrorSchema.parse(await readJson(blocked.res)).error.code).toBe("rate_limited");
  });

  it("rejects an expired challenge", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { secret } = await enableTotp(client);
    const challenge = await startLogin(known);
    await db
      .update(authChallenges)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(authChallenges.kind, "2fa"));
    const res = await verify(challenge.challengeToken, {
      method: "totp",
      code: totpCode(secret, Date.now() + 30_000),
    });
    expect(res.res.status).toBe(400);
  });

  it("refuses a user who was disabled between the two steps", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { secret } = await enableTotp(client);
    const challenge = await startLogin(known);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, known.user.id));
    const res = await verify(challenge.challengeToken, {
      method: "totp",
      code: totpCode(secret, Date.now() + 30_000),
    });
    expect(res.res.status).toBe(403);
    expect(apiErrorSchema.parse(await readJson(res.res)).error.code).toBe("account_disabled");
  });
});

describe("backup codes", () => {
  beforeEach(resetDb);

  it("work once each", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { backupCodes: codes } = await enableTotp(client);
    const [first, second] = codes ?? [];
    if (!first || !second) throw new Error("expected backup codes");

    const challenge = await startLogin(known);
    expect(challenge.methods).toContain("backup_code");
    const ok = await verify(challenge.challengeToken, { method: "backup_code", code: first });
    expect(ok.res.status).toBe(200);
    loginOkResponseSchema.parse(await readJson(ok.res));

    // The same code does not work again, on a fresh challenge.
    const next = await startLogin(known);
    const reused = await verify(next.challengeToken, { method: "backup_code", code: first });
    expect(reused.res.status).toBe(401);
    // Dashes and case do not matter for another code.
    const flexible = await verify(next.challengeToken, {
      method: "backup_code",
      code: second.replace("-", "").toUpperCase(),
    });
    expect(flexible.res.status).toBe(200);

    const stored = await db.select().from(backupCodes).where(eq(backupCodes.userId, known.user.id));
    expect(stored.filter((row) => row.usedAt !== null)).toHaveLength(2);
  });

  it("regenerating invalidates the old set", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { backupCodes: original } = await enableTotp(client);
    const res = await client.post(apiPaths.me.backupCodes);
    expect(res.status).toBe(200);
    const fresh = backupCodesResponseSchema.parse(await readJson(res)).backupCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(original);

    const challenge = await startLogin(known);
    const old = await verify(challenge.challengeToken, {
      method: "backup_code",
      code: original?.[0] ?? "",
    });
    expect(old.res.status).toBe(401);
    const ok = await verify(challenge.challengeToken, {
      method: "backup_code",
      code: fresh[0] ?? "",
    });
    expect(ok.res.status).toBe(200);
  });

  it("cannot be generated without a second factor", async () => {
    const { client } = await loginAs(await createKnownUser());
    expect((await client.post(apiPaths.me.backupCodes)).status).toBe(409);
  });
});

describe("disabling TOTP", () => {
  beforeEach(resetDb);

  it("needs a current code, then turns 2FA off and deletes the backup codes", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { secret } = await enableTotp(client);

    const bare = await client.post(apiPaths.me.totpDisable, {});
    expect(bare.status).toBe(400);
    const wrong = await client.post(apiPaths.me.totpDisable, { method: "totp", code: "000000" });
    expect(wrong.status).toBe(401);
    expect(
      await db.select().from(backupCodes).where(eq(backupCodes.userId, known.user.id)),
    ).toHaveLength(10);

    const ok = await client.post(apiPaths.me.totpDisable, {
      method: "totp",
      code: totpCode(secret, Date.now() + 30_000),
    });
    expect(ok.status).toBe(200);
    expect(okResponseSchema.parse(await readJson(ok))).toEqual({ ok: true });

    const row = await db.select().from(users).where(eq(users.id, known.user.id)).get();
    expect(row?.totpSecretEnc).toBeNull();
    expect(row?.totpLastStep).toBeNull();
    expect(
      await db.select().from(backupCodes).where(eq(backupCodes.userId, known.user.id)),
    ).toHaveLength(0);

    // Login is single step again.
    const login = await createClient().post(apiPaths.auth.login, {
      email: known.user.email,
      authKey: known.authKey,
    });
    expect(loginOkResponseSchema.parse(await readJson(login)).status).toBe("ok");
    const notices = emailsTo(known.user.email).filter((m) =>
      m.subject.startsWith("Security notice"),
    );
    expect(notices.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a backup code instead of a TOTP code", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { backupCodes: codes } = await enableTotp(client);
    const res = await client.post(apiPaths.me.totpDisable, {
      method: "backup_code",
      code: codes?.[3] ?? "",
    });
    expect(res.status).toBe(200);
  });

  it("is a conflict when TOTP is not on", async () => {
    const { client } = await loginAs(await createKnownUser());
    const res = await client.post(apiPaths.me.totpDisable, { method: "totp", code: "123456" });
    expect(res.status).toBe(409);
  });
});

describe("passkeys (WebAuthn) with a virtual authenticator", () => {
  beforeEach(resetDb);

  async function registerPasskey(client: TestClient, name = "Laptop") {
    const authenticator = await VirtualAuthenticator.create(ORIGIN);
    const optionsRes = await client.post(apiPaths.me.webauthnRegisterOptions);
    expect(optionsRes.status).toBe(200);
    const { options } = webauthnRegisterOptionsResponseSchema.parse(await readJson(optionsRes));
    const credential = await authenticator.register(options.challenge);
    const res = await client.post(apiPaths.me.webauthnRegisterVerify, { name, credential });
    return { authenticator, options, res };
  }

  it("registers a passkey, issues backup codes once, lists and removes it", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);

    const { options, res, authenticator } = await registerPasskey(client);
    expect(options.rp.id).toBe("pm.test");
    expect(options.user.name).toBe(known.user.email);
    expect(res.status).toBe(201);
    const body = webauthnRegisterVerifyResponseSchema.parse(await readJson(res));
    expect(body.credential.name).toBe("Laptop");
    expect(body.backupCodes).toHaveLength(10); // first 2FA method

    const list = listPasskeysResponseSchema.parse(
      await readJson(await client.get(apiPaths.me.webauthn)),
    );
    expect(list.credentials.map((c) => c.id)).toEqual([body.credential.id]);
    const stored = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, known.user.id));
    expect(stored[0]?.credentialId).toBe(authenticator.credentialId);
    const me = meResponseSchema.parse(await readJson(await client.get(apiPaths.me.root)));
    expect(me.user.twoFactor).toEqual({ totp: false, webauthn: 1 });

    // A second passkey does not mint new backup codes; the same challenge cannot be reused.
    const second = await registerPasskey(client, "Phone");
    expect(second.res.status).toBe(201);
    expect(
      webauthnRegisterVerifyResponseSchema.parse(await readJson(second.res)).backupCodes,
    ).toBeNull();
    const reuse = await client.post(apiPaths.me.webauthnRegisterVerify, {
      name: "Again",
      credential: await second.authenticator.register(second.options.challenge),
    });
    expect(reuse.status).toBe(400);

    // Removing one keeps 2FA; removing the last turns it off and deletes the backup codes.
    const remove1 = await client.delete(apiPaths.me.webauthnCredential(body.credential.id));
    expect(remove1.status).toBe(200);
    expect(
      await db.select().from(backupCodes).where(eq(backupCodes.userId, known.user.id)),
    ).toHaveLength(10);
    const rest = listPasskeysResponseSchema.parse(
      await readJson(await client.get(apiPaths.me.webauthn)),
    );
    expect(rest.credentials).toHaveLength(1);
    const lastId = rest.credentials[0]?.id ?? "";
    expect((await client.delete(apiPaths.me.webauthnCredential(lastId))).status).toBe(200);
    expect(
      await db.select().from(backupCodes).where(eq(backupCodes.userId, known.user.id)),
    ).toHaveLength(0);
    expect((await client.delete(apiPaths.me.webauthnCredential(lastId))).status).toBe(404);

    const events = (
      await db.select().from(auditEvents).where(eq(auditEvents.userId, known.user.id))
    ).map((e) => e.event);
    expect(events).toContain("passkey_added");
    expect(events).toContain("passkey_removed");
    expect(
      emailsTo(known.user.email).filter((m) => m.subject.startsWith("Security notice")).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("excludes existing credentials from new registration options", async () => {
    const { client } = await loginAs(await createKnownUser());
    const first = await registerPasskey(client);
    expect(first.res.status).toBe(201);
    const { options } = webauthnRegisterOptionsResponseSchema.parse(
      await readJson(await client.post(apiPaths.me.webauthnRegisterOptions)),
    );
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([
      first.authenticator.credentialId,
    ]);
  });

  it("rejects bogus or mismatched registrations", async () => {
    const { client } = await loginAs(await createKnownUser());
    const authenticator = await VirtualAuthenticator.create(ORIGIN);
    const { options } = webauthnRegisterOptionsResponseSchema.parse(
      await readJson(await client.post(apiPaths.me.webauthnRegisterOptions)),
    );

    // Wrong challenge.
    const wrongChallenge = await client.post(apiPaths.me.webauthnRegisterVerify, {
      name: "x",
      credential: await authenticator.register("d3Jvbmc"),
    });
    expect(wrongChallenge.status).toBe(400);
    // Wrong origin.
    const wrongOrigin = await client.post(apiPaths.me.webauthnRegisterVerify, {
      name: "x",
      credential: await authenticator.register(options.challenge, "https://evil.test"),
    });
    expect(wrongOrigin.status).toBe(400);
    // Garbage.
    const garbage = await client.post(apiPaths.me.webauthnRegisterVerify, {
      name: "x",
      credential: {
        id: "AAAA",
        rawId: "AAAA",
        type: "public-key",
        response: { clientDataJSON: "AAAA", attestationObject: "AAAA" },
      },
    });
    expect(garbage.status).toBe(400);
    expect(await db.select().from(webauthnCredentials)).toHaveLength(0);
    // No registration without options first.
    const { client: other } = await loginAs(await createKnownUser());
    const none = await other.post(apiPaths.me.webauthnRegisterVerify, {
      name: "x",
      credential: await authenticator.register(options.challenge),
    });
    expect(none.status).toBe(400);
  });

  it("logs in with a passkey assertion and updates the counter", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { authenticator, res } = await registerPasskey(client);
    expect(res.status).toBe(201);

    const challenge = await startLogin(known);
    expect(challenge.methods).toEqual(["webauthn", "backup_code"]);
    const optionsRes = await createClient().post(apiPaths.auth.webauthnOptions, {
      challengeToken: challenge.challengeToken,
    });
    expect(optionsRes.status).toBe(200);
    const { options } = webauthnOptionsResponseSchema.parse(await readJson(optionsRes));
    expect(options.rpId).toBe("pm.test");
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([authenticator.credentialId]);

    const assertion = await authenticator.assert(options.challenge);
    const ok = await verify(challenge.challengeToken, { method: "webauthn", assertion });
    expect(ok.res.status).toBe(200);
    expect(twoFactorVerifyResponseSchema.parse(await readJson(ok.res)).user.id).toBe(known.user.id);
    expect((await ok.client.get(apiPaths.me.root)).status).toBe(200);

    const stored = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, known.user.id))
      .get();
    expect(stored?.counter).toBe(1);
    expect(stored?.lastUsedAt).toBeGreaterThan(0);

    // A second login with a replayed (old counter) assertion fails.
    const second = await startLogin(known);
    const secondOptions = webauthnOptionsResponseSchema.parse(
      await readJson(
        await createClient().post(apiPaths.auth.webauthnOptions, {
          challengeToken: second.challengeToken,
        }),
      ),
    );
    const replayed = await verify(second.challengeToken, { method: "webauthn", assertion });
    expect(replayed.res.status).toBe(401);
    const fresh = await verify(second.challengeToken, {
      method: "webauthn",
      assertion: await authenticator.assert(secondOptions.options.challenge),
    });
    expect(fresh.res.status).toBe(200);
  });

  it("rejects bogus assertions and assertions without issued options", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    const { authenticator } = await registerPasskey(client);

    const challenge = await startLogin(known);
    const noOptions = await verify(challenge.challengeToken, {
      method: "webauthn",
      assertion: await authenticator.assert("YW55dGhpbmc"),
    });
    expect(noOptions.res.status).toBe(401);

    const { options } = webauthnOptionsResponseSchema.parse(
      await readJson(
        await createClient().post(apiPaths.auth.webauthnOptions, {
          challengeToken: challenge.challengeToken,
        }),
      ),
    );
    // Garbage signature.
    const real = await authenticator.assert(options.challenge);
    const forged = { ...real, response: { ...real.response, signature: "AAAA" } };
    const bad = await verify(challenge.challengeToken, { method: "webauthn", assertion: forged });
    expect(bad.res.status).toBe(401);
    expect(apiErrorSchema.parse(await readJson(bad.res)).error.code).toBe("invalid_two_factor");
    // Wrong challenge, wrong origin, unknown credential.
    const wrongChallenge = await verify(challenge.challengeToken, {
      method: "webauthn",
      assertion: await authenticator.assert("d3Jvbmc"),
    });
    expect(wrongChallenge.res.status).toBe(401);
    const wrongOrigin = await verify(challenge.challengeToken, {
      method: "webauthn",
      assertion: await authenticator.assert(options.challenge, "https://evil.test"),
    });
    expect(wrongOrigin.res.status).toBe(401);
    const stranger = await VirtualAuthenticator.create(ORIGIN);
    const unknown = await verify(challenge.challengeToken, {
      method: "webauthn",
      assertion: await stranger.assert(options.challenge),
    });
    expect(unknown.res.status).toBe(401);
    // The real one still works afterwards.
    const ok = await verify(challenge.challengeToken, {
      method: "webauthn",
      assertion: await authenticator.assert(options.challenge),
    });
    expect(ok.res.status).toBe(200);
  });

  it("only issues options for a live login challenge of a user with passkeys", async () => {
    const known = await createKnownUser();
    const { client } = await loginAs(known);
    await enableTotp(client); // TOTP only, no passkeys
    const challenge = await startLogin(known);
    const none = await createClient().post(apiPaths.auth.webauthnOptions, {
      challengeToken: challenge.challengeToken,
    });
    expect(none.status).toBe(409);
    const bogus = await createClient().post(apiPaths.auth.webauthnOptions, {
      challengeToken: "A".repeat(43),
    });
    expect(bogus.status).toBe(400);
    expect(apiErrorSchema.parse(await readJson(bogus)).error.code).toBe("challenge_invalid");
  });

  it("keeps regenerate-after-passkey backup code helper working", async () => {
    const { client } = await loginAs(await createKnownUser());
    await registerPasskey(client);
    expect(await regenerateBackupCodes(client)).toHaveLength(10);
  });
});
