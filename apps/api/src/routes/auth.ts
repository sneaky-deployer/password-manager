import {
  acceptInviteRequestSchema,
  EMAIL_CODE_TTL_MINUTES,
  emailStartRequestSchema,
  loginRequestSchema,
  preloginRequestSchema,
  RECOVERY_TOKEN_TTL_MINUTES,
  recoveryCompleteRequestSchema,
  recoveryStartRequestSchema,
  resetAccountRequestSchema,
  TWO_FACTOR_CHALLENGE_TTL_MINUTES,
  type TwoFactorMethod,
  twoFactorVerifyRequestSchema,
  webauthnOptionsRequestSchema,
} from "@pm/shared";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getDb } from "../db/client.ts";
import { authChallenges, invites, type User, users, webauthnCredentials } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { buildNewAccount } from "../lib/account/account-creation.ts";
import { deleteUserStatements } from "../lib/account/account-deletion.ts";
import {
  afterResponse,
  assertNotLimited,
  challengeInvalid,
  clientIp,
  emailKey,
  hitOrThrow,
  recordFailure,
  requireEmptyBody,
  runBatch,
  sendSecurityNotice,
  sendTemplate,
  userAgentOf,
} from "../lib/account/common.ts";
import {
  checkEmailCode,
  consumeEmailCodeRow,
  issueEmailCode,
  verifyAndConsumeEmailCode,
} from "../lib/account/email-codes.ts";
import { findLiveInvite, INVITE_LIMIT, inviteLimitKey } from "../lib/account/invites.ts";
import { buildPasswordUpdate } from "../lib/account/password.ts";
import {
  buildChallenge,
  consumeBackupCode,
  findChallengeByToken,
  LOGIN_CHALLENGE_PURPOSE,
  loadTwoFactorState,
  parsePayload,
  takeChallenge,
  verifyUserTotp,
} from "../lib/account/two-factor.ts";
import {
  checkDummyVerifier,
  checkVerifier,
  toKeyBundle,
  toMeSummary,
} from "../lib/account/verifiers.ts";
import { authenticationOptions, verifyAssertion } from "../lib/account/webauthn.ts";
import { auditStatement } from "../lib/audit.ts";
import { fakeSalt } from "../lib/crypto.ts";
import { emailCodeEmail } from "../lib/email-templates.ts";
import { AppError, isUniqueViolation } from "../lib/errors.ts";
import {
  clearSessionCookie,
  destroyAllSessionsStatement,
  destroySession,
  prepareSession,
} from "../lib/sessions.ts";
import { validate } from "../lib/validate.ts";

const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_EMAIL_LIMIT = 10;
const LOGIN_IP_LIMIT = 30;
const TWO_FACTOR_LIMIT = 10;
const EMAIL_CODE_HOURLY_LIMIT = 5;
const RECOVERY_HOURLY_LIMIT = 5;
const HOUR_SECONDS = 60 * 60;

const twoFactorLimitKey = (userId: string) => `2fa:user:${userId}`;

/** Methods offered on the recovery path (passkeys cannot answer there; backup codes can). */
function recoveryMethods(methods: TwoFactorMethod[]): TwoFactorMethod[] {
  return methods.filter((method) => method !== "webauthn");
}

export const auth = new Hono<AppEnv>()
  // --- Account creation from an invite (PLAN.md 10.1) -------------------------------------------
  .post("/accept-invite", validate("json", acceptInviteRequestSchema), async (c) => {
    const db = getDb(c.env);
    const config = c.var.config;
    await hitOrThrow(
      c,
      db,
      inviteLimitKey(clientIp(c)),
      INVITE_LIMIT.limit,
      INVITE_LIMIT.windowSeconds,
    );
    const { token, ...material } = c.req.valid("json");
    const invite = await findLiveInvite(db, token);
    if (!invite) throw new AppError("invite_invalid", 410);

    const existing = await db.select().from(users).where(eq(users.email, invite.email)).get();
    if (existing && invite.kind === "new_account") throw new AppError("email_taken", 409);

    const now = Date.now();
    const account = await buildNewAccount(db, config, material, {
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invitedBy,
      userAgent: userAgentOf(c),
      auditEvent: "account_created",
      auditMeta: { via: invite.kind },
      now,
    });
    try {
      await runBatch(db, [
        // An admin reset normally removed the old account already; if it is still there, replace it.
        ...(existing ? deleteUserStatements(db, existing.id, now) : []),
        ...account.statements,
        db.update(invites).set({ acceptedAt: now }).where(eq(invites.id, invite.id)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const taken = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, invite.email))
          .get();
        throw taken ? new AppError("email_taken", 409) : new AppError("conflict", 409);
      }
      throw error;
    }
    c.header("Set-Cookie", account.session.cookie, { append: true });
    return c.json({ user: toMeSummary(account.user, 0) }, 201);
  })

  // --- Email codes for the signed-out flows (PLAN.md 10.5) ---------------------------------------
  .post("/email/start", validate("json", emailStartRequestSchema), async (c) => {
    const db = getDb(c.env);
    const { email, purpose } = c.req.valid("json");
    await hitOrThrow(
      c,
      db,
      `email-code:email:${await emailKey(email)}`,
      EMAIL_CODE_HOURLY_LIMIT,
      HOUR_SECONDS,
    );
    await hitOrThrow(c, db, `email-code:ip:${clientIp(c)}`, 20, HOUR_SECONDS);

    const user = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, email))
      .get();
    // A code row is written either way, so a known and an unknown email cost the same; only a
    // real, active account actually receives mail. The response never differs.
    const code = await issueEmailCode(db, email, purpose);
    if (user && user.status === "active") {
      await afterResponse(c, () =>
        sendTemplate(
          c,
          email,
          emailCodeEmail({ code, purpose, expiresMinutes: EMAIL_CODE_TTL_MINUTES }),
        ),
      );
    }
    return c.json({ ok: true as const });
  })

  // --- Login (PLAN.md 10.2) -----------------------------------------------------------------------
  .post("/prelogin", validate("json", preloginRequestSchema), async (c) => {
    const { email } = c.req.valid("json");
    const config = c.var.config;
    const user = await getDb(c.env)
      .select({
        kdfAlg: users.kdfAlg,
        kdfMem: users.kdfMem,
        kdfOps: users.kdfOps,
        salt: users.kdfSalt,
      })
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (user) {
      return c.json({
        kdf: { alg: "argon2id13" as const, mem: user.kdfMem, ops: user.kdfOps },
        salt: user.salt,
      });
    }
    return c.json({
      kdf: { alg: "argon2id13" as const, mem: config.kdfDefaultMem, ops: config.kdfDefaultOps },
      salt: await fakeSalt(config.fakeSaltKey, email),
    });
  })

  .post("/login", validate("json", loginRequestSchema), async (c) => {
    const db = getDb(c.env);
    const config = c.var.config;
    const { email, authKey } = c.req.valid("json");
    const emailBucket = `login:email:${await emailKey(email)}`;
    const ipBucket = `login:ip:${clientIp(c)}`;
    // Only failures count, so a legitimate user is never locked out by their own successes.
    await assertNotLimited(c, db, emailBucket, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_SECONDS);
    await assertNotLimited(c, db, ipBucket, LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS);

    const user = await db.select().from(users).where(eq(users.email, email)).get();
    const verified = user
      ? await checkVerifier(config, authKey, user.authVerifier)
      : await checkDummyVerifier(config, authKey);
    if (!user || !verified) {
      await Promise.all([
        recordFailure(db, emailBucket, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_SECONDS),
        recordFailure(db, ipBucket, LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS),
      ]);
      throw new AppError("invalid_credentials", 401);
    }
    if (user.status !== "active") throw new AppError("account_disabled", 403);

    const state = await loadTwoFactorState(db, user);
    if (state.enabled) {
      const challenge = await buildChallenge(
        user.id,
        "2fa",
        { purpose: LOGIN_CHALLENGE_PURPOSE },
        TWO_FACTOR_CHALLENGE_TTL_MINUTES * 60 * 1000,
      );
      await db.insert(authChallenges).values(challenge.row);
      return c.json({
        status: "two_factor_required" as const,
        challengeToken: challenge.token,
        methods: state.methods,
      });
    }
    return completeLogin(c, user, "password", 0);
  })

  .post("/2fa/verify", validate("json", twoFactorVerifyRequestSchema), async (c) => {
    const db = getDb(c.env);
    const config = c.var.config;
    const body = c.req.valid("json");

    const challenge = await findChallengeByToken(db, "2fa", body.challengeToken);
    if (!challenge || parsePayload(challenge).purpose !== LOGIN_CHALLENGE_PURPOSE) {
      throw challengeInvalid();
    }
    const limitKey = twoFactorLimitKey(challenge.userId);
    await assertNotLimited(c, db, limitKey, TWO_FACTOR_LIMIT, LOGIN_WINDOW_SECONDS);

    const user = await db.select().from(users).where(eq(users.id, challenge.userId)).get();
    if (!user) throw challengeInvalid();
    if (user.status !== "active") throw new AppError("account_disabled", 403);

    let valid = false;
    let passkeyUse: { id: string; counter: number } | null = null;
    if (body.method === "totp") {
      valid = await verifyUserTotp(db, config, user, body.code);
    } else if (body.method === "backup_code") {
      valid = await consumeBackupCode(db, user.id, body.code);
    } else {
      const expected = parsePayload(challenge).webauthnChallenge;
      const stored =
        typeof expected === "string"
          ? await db
              .select()
              .from(webauthnCredentials)
              .where(
                and(
                  eq(webauthnCredentials.credentialId, body.assertion.id),
                  eq(webauthnCredentials.userId, user.id),
                ),
              )
              .get()
          : undefined;
      if (stored && typeof expected === "string") {
        const counter = await verifyAssertion(config, stored, body.assertion, expected);
        if (counter !== null) {
          valid = true;
          passkeyUse = { id: stored.id, counter };
        }
      }
    }
    if (!valid) {
      await recordFailure(db, limitKey, TWO_FACTOR_LIMIT, LOGIN_WINDOW_SECONDS);
      throw new AppError("invalid_two_factor", 401);
    }
    // The challenge works once: whoever removes it first wins.
    if (!(await takeChallenge(db, challenge.id))) throw challengeInvalid();
    if (passkeyUse) {
      await db
        .update(webauthnCredentials)
        .set({ counter: passkeyUse.counter, lastUsedAt: Date.now() })
        .where(eq(webauthnCredentials.id, passkeyUse.id));
    }

    const state = await loadTwoFactorState(db, user);
    return completeLogin(c, user, body.method, state.passkeys);
  })

  .post("/webauthn/options", validate("json", webauthnOptionsRequestSchema), async (c) => {
    const db = getDb(c.env);
    const { challengeToken } = c.req.valid("json");
    const challenge = await findChallengeByToken(db, "2fa", challengeToken);
    const payload = challenge ? parsePayload(challenge) : {};
    if (!challenge || payload.purpose !== LOGIN_CHALLENGE_PURPOSE) throw challengeInvalid();
    await hitOrThrow(c, db, `2fa-options:${challenge.id}`, TWO_FACTOR_LIMIT, LOGIN_WINDOW_SECONDS);

    const credentials = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, challenge.userId));
    if (credentials.length === 0) {
      throw new AppError("conflict", 409, "No passkeys are registered for this account.");
    }
    const options = await authenticationOptions(c.var.config, credentials);
    await db
      .update(authChallenges)
      .set({ payload: JSON.stringify({ ...payload, webauthnChallenge: options.challenge }) })
      .where(eq(authChallenges.id, challenge.id));
    return c.json({ options });
  })

  // --- Forgot password: recovery kit (PLAN.md 10.5 A) ---------------------------------------------
  .post("/recovery/start", validate("json", recoveryStartRequestSchema), async (c) => {
    const db = getDb(c.env);
    const config = c.var.config;
    const { email, emailCode, recoveryAuthKey, twoFactor } = c.req.valid("json");
    await hitOrThrow(
      c,
      db,
      `recovery:email:${await emailKey(email)}`,
      RECOVERY_HOURLY_LIMIT,
      HOUR_SECONDS,
    );

    // Check (not consume) the code first: this request is retried with the same code when it
    // answers `two_factor_required`. The code is consumed together with the recovery token.
    const codeCheck = await checkEmailCode(db, email, "recovery", emailCode);
    if (!codeCheck.ok || !codeCheck.rowId) throw new AppError("email_code_invalid", 400);
    const user = await db.select().from(users).where(eq(users.email, email)).get();
    if (!user) throw new AppError("email_code_invalid", 400);
    if (!(await checkVerifier(config, recoveryAuthKey, user.recoveryVerifier))) {
      throw new AppError("invalid_credentials", 401);
    }
    if (user.status !== "active") throw new AppError("account_disabled", 403);

    const state = await loadTwoFactorState(db, user);
    if (state.enabled) {
      const methods = recoveryMethods(state.methods);
      if (!twoFactor) {
        throw new AppError("two_factor_required", 401, undefined, { methods });
      }
      const limitKey = twoFactorLimitKey(user.id);
      await assertNotLimited(c, db, limitKey, TWO_FACTOR_LIMIT, LOGIN_WINDOW_SECONDS);
      const valid =
        twoFactor.method === "totp"
          ? await verifyUserTotp(db, config, user, twoFactor.code)
          : await consumeBackupCode(db, user.id, twoFactor.code);
      if (!valid) {
        await recordFailure(db, limitKey, TWO_FACTOR_LIMIT, LOGIN_WINDOW_SECONDS);
        throw new AppError("invalid_two_factor", 401);
      }
    }

    const now = Date.now();
    if (!(await consumeEmailCodeRow(db, codeCheck.rowId, now))) {
      throw new AppError("email_code_invalid", 400);
    }
    const challenge = await buildChallenge(
      user.id,
      "recovery",
      {},
      RECOVERY_TOKEN_TTL_MINUTES * 60 * 1000,
      now,
    );
    await runBatch(db, [
      // Only the newest recovery token works.
      db
        .delete(authChallenges)
        .where(and(eq(authChallenges.userId, user.id), eq(authChallenges.kind, "recovery"))),
      db.insert(authChallenges).values(challenge.row),
      auditStatement(db, user.id, "recovery_started", {}, now),
    ]);
    return c.json({
      userId: user.id,
      wrappedAkRec: user.wrappedAkRec,
      recoveryToken: challenge.token,
    });
  })

  .post("/recovery/complete", validate("json", recoveryCompleteRequestSchema), async (c) => {
    const db = getDb(c.env);
    const config = c.var.config;
    const { recoveryToken, ...change } = c.req.valid("json");
    const challenge = await findChallengeByToken(db, "recovery", recoveryToken);
    if (!challenge) throw challengeInvalid();
    const user = await db.select().from(users).where(eq(users.id, challenge.userId)).get();
    if (!user) throw challengeInvalid();
    if (user.status !== "active") throw new AppError("account_disabled", 403);
    // Single use: whoever deletes the challenge first proceeds.
    if (!(await takeChallenge(db, challenge.id))) throw challengeInvalid();

    const now = Date.now();
    const { statement, updated } = await buildPasswordUpdate(db, config, user, change, {
      bumpStamp: true,
      lastLogin: true,
      now,
    });
    const session = await prepareSession(db, config, updated, userAgentOf(c), now);
    await runBatch(db, [
      statement,
      // Every other device signs out; the new session below is stamped with the bumped value.
      destroyAllSessionsStatement(db, user.id),
      session.insert,
      auditStatement(db, user.id, "recovery_used", {}, now),
    ]);
    c.header("Set-Cookie", session.cookie, { append: true });
    await sendSecurityNotice(c, user.email, "recovery_used");
    const state = await loadTwoFactorState(db, updated);
    return c.json({
      status: "ok" as const,
      user: toMeSummary(updated, state.passkeys),
      keys: toKeyBundle(updated),
    });
  })
  // --- Reset account: last resort, data is lost (PLAN.md 10.5 D) -----------------------------------
  .post("/reset-account", validate("json", resetAccountRequestSchema), async (c) => {
    const db = getDb(c.env);
    const config = c.var.config;
    const { email, emailCode, ...material } = c.req.valid("json");
    await hitOrThrow(
      c,
      db,
      `reset-account:email:${await emailKey(email)}`,
      RECOVERY_HOURLY_LIMIT,
      HOUR_SECONDS,
    );
    const user = await db.select().from(users).where(eq(users.email, email)).get();
    const codeOk = await verifyAndConsumeEmailCode(db, email, "reset_account", emailCode);
    if (!codeOk || !user) throw new AppError("email_code_invalid", 400);
    // A disabled account must not be able to wipe and recreate itself around the admin's decision.
    if (user.status !== "active") throw new AppError("account_disabled", 403);

    const now = Date.now();
    const account = await buildNewAccount(db, config, material, {
      email: user.email,
      role: user.role,
      invitedBy: null,
      userAgent: userAgentOf(c),
      auditEvent: "account_reset",
      auditMeta: { via: "self" },
      now,
    });
    try {
      await runBatch(db, [...deleteUserStatements(db, user.id, now), ...account.statements]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("conflict", 409);
      throw error;
    }
    c.header("Set-Cookie", account.session.cookie, { append: true });
    await sendSecurityNotice(c, user.email, "account_reset");
    return c.json({ user: toMeSummary(account.user, 0) }, 201);
  })

  // --- Logout ---------------------------------------------------------------------------------------
  .post("/logout", async (c) => {
    await requireEmptyBody(c);
    if (c.var.session) await destroySession(getDb(c.env), c.var.session.id);
    c.header("Set-Cookie", clearSessionCookie(c.var.config), { append: true });
    return c.json({ ok: true as const });
  });

/** Creates the session for a verified login and builds the `status: "ok"` response. */
async function completeLogin(c: Context<AppEnv>, user: User, method: string, passkeys: number) {
  const db = getDb(c.env);
  const now = Date.now();
  const session = await prepareSession(db, c.var.config, user, userAgentOf(c), now);
  await runBatch(db, [
    session.insert,
    db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)),
    auditStatement(db, user.id, "login", { method }, now),
  ]);
  c.header("Set-Cookie", session.cookie, { append: true });
  return c.json({
    status: "ok" as const,
    user: toMeSummary(user, passkeys),
    keys: toKeyBundle(user),
  });
}
