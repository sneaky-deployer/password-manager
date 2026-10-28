import {
  activityQuerySchema,
  changePasswordRequestSchema,
  deleteAccountRequestSchema,
  EMAIL_CODE_TTL_MINUTES,
  idParamsSchema,
  kdfUpgradeRequestSchema,
  type PasswordChange,
  recoveryTwoFactorSchema,
  replaceRecoveryRequestSchema,
  resetFromUnlockedRequestSchema,
  totpEnableRequestSchema,
  updateSettingsRequestSchema,
  webauthnRegisterVerifyRequestSchema,
} from "@pm/shared";
import { and, asc, desc, eq, lt, ne } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getDb } from "../db/client.ts";
import {
  auditEvents,
  authChallenges,
  backupCodes,
  sessions,
  type User,
  users,
  webauthnCredentials,
} from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { deleteUserStatements } from "../lib/account/account-deletion.ts";
import {
  afterResponse,
  assertNotLimited,
  challengeInvalid,
  emailKey,
  hitOrThrow,
  readOptionalJson,
  recordFailure,
  requireEmptyBody,
  runBatch,
  sendSecurityNotice,
  sendTemplate,
  userAgentOf,
} from "../lib/account/common.ts";
import { issueEmailCode, verifyAndConsumeEmailCode } from "../lib/account/email-codes.ts";
import { buildPasswordUpdate } from "../lib/account/password.ts";
import {
  buildBackupCodeSet,
  buildSingletonChallenge,
  consumeBackupCode,
  decryptTotpSecret,
  encryptTotpSecret,
  findSingletonChallenge,
  generateTotpSecret,
  loadTwoFactorState,
  matchTotpStep,
  parsePayload,
  TOTP_SETUP_PURPOSE,
  totpUri,
  verifyUserTotp,
} from "../lib/account/two-factor.ts";
import {
  checkVerifier,
  computeVerifier,
  countPasskeys,
  parseSettings,
  toKeyBundle,
  toMeSummary,
} from "../lib/account/verifiers.ts";
import { registrationOptions, verifyRegistration } from "../lib/account/webauthn.ts";
import { auditStatement } from "../lib/audit.ts";
import { newId } from "../lib/crypto.ts";
import { emailCodeEmail } from "../lib/email-templates.ts";
import { AppError, isUniqueViolation } from "../lib/errors.ts";
import {
  clearSessionCookie,
  destroyAllSessionsStatement,
  prepareSession,
} from "../lib/sessions.ts";
import { validate } from "../lib/validate.ts";
import { getAuth, requireAuth } from "../middleware/session.ts";

const WINDOW_SECONDS = 15 * 60;
const FAILURE_LIMIT = 10;
const SETUP_TTL_MS = 15 * 60 * 1000;
const WEBAUTHN_TTL_MS = 5 * 60 * 1000;

/**
 * The current password proof for sensitive actions. Failures are counted per user so a stolen
 * session cookie cannot be used to grind through guesses of the authKey.
 */
async function requireCurrentAuthKey(c: Context<AppEnv>, user: User, authKey: string) {
  const db = getDb(c.env);
  const key = `pwcheck:user:${user.id}`;
  await assertNotLimited(c, db, key, FAILURE_LIMIT, WINDOW_SECONDS);
  if (!(await checkVerifier(c.var.config, authKey, user.authVerifier))) {
    await recordFailure(db, key, FAILURE_LIMIT, WINDOW_SECONDS);
    throw new AppError("invalid_credentials", 401);
  }
}

/** Verifies a TOTP or backup code for disabling a factor; counts failures per user. */
async function requireSecondFactor(
  c: Context<AppEnv>,
  user: User,
  factor: { method: "totp" | "backup_code"; code: string },
) {
  const db = getDb(c.env);
  const key = `2fa:user:${user.id}`;
  await assertNotLimited(c, db, key, FAILURE_LIMIT, WINDOW_SECONDS);
  const valid =
    factor.method === "totp"
      ? await verifyUserTotp(db, c.var.config, user, factor.code)
      : await consumeBackupCode(db, user.id, factor.code);
  if (!valid) {
    await recordFailure(db, key, FAILURE_LIMIT, WINDOW_SECONDS);
    throw new AppError("invalid_two_factor", 401);
  }
}

/**
 * Applies new password material, signs every device out (the security stamp is bumped) and gives
 * this device a fresh session in the same batch (PLAN.md 10.4, 10.5 B).
 */
async function replacePassword(
  c: Context<AppEnv>,
  user: User,
  change: PasswordChange,
  meta: Record<string, string>,
) {
  const db = getDb(c.env);
  const config = c.var.config;
  const now = Date.now();
  const { statement, updated } = await buildPasswordUpdate(db, config, user, change, {
    bumpStamp: true,
    now,
  });
  const session = await prepareSession(db, config, updated, userAgentOf(c), now);
  await runBatch(db, [
    statement,
    destroyAllSessionsStatement(db, user.id),
    session.insert,
    // A recovery token issued before the change must not survive it.
    db
      .delete(authChallenges)
      .where(and(eq(authChallenges.userId, user.id), eq(authChallenges.kind, "recovery"))),
    auditStatement(db, user.id, "password_changed", meta, now),
  ]);
  c.header("Set-Cookie", session.cookie, { append: true });
  await sendSecurityNotice(c, user.email, "password_changed");
  return c.json({ ok: true as const });
}

/** Deletes the pending TOTP / passkey registration rows, if any, and inserts the new one. */
function replaceSingleton(
  db: ReturnType<typeof getDb>,
  row: Awaited<ReturnType<typeof buildSingletonChallenge>>,
) {
  return [
    db.delete(authChallenges).where(eq(authChallenges.tokenHash, row.tokenHash)),
    db.insert(authChallenges).values(row),
  ] as const;
}

export const me = new Hono<AppEnv>()
  .use(requireAuth)

  // --- Profile and keys -----------------------------------------------------------------------------
  .get("/", async (c) => {
    const { user } = getAuth(c);
    return c.json({ user: toMeSummary(user, await countPasskeys(getDb(c.env), user.id)) });
  })
  .get("/keys", (c) => c.json(toKeyBundle(getAuth(c).user)))

  // --- Sensitive action email code -------------------------------------------------------------------
  .post("/email-code", async (c) => {
    await requireEmptyBody(c);
    const { user } = getAuth(c);
    const db = getDb(c.env);
    // Separate bucket from the signed-out flows, so spam there cannot lock the owner out here.
    await hitOrThrow(c, db, `email-code:me:${await emailKey(user.email)}`, 5, 60 * 60);
    const code = await issueEmailCode(db, user.email, "sensitive_action");
    await afterResponse(c, () =>
      sendTemplate(
        c,
        user.email,
        emailCodeEmail({
          code,
          purpose: "sensitive_action",
          expiresMinutes: EMAIL_CODE_TTL_MINUTES,
        }),
      ),
    );
    return c.json({ ok: true as const });
  })

  // --- Password, recovery kit, KDF -------------------------------------------------------------------
  .post("/password", validate("json", changePasswordRequestSchema), async (c) => {
    const { user } = getAuth(c);
    const { currentAuthKey, ...change } = c.req.valid("json");
    await requireCurrentAuthKey(c, user, currentAuthKey);
    return replacePassword(c, user, change, { via: "current_password" });
  })
  .post(
    "/password/reset-from-unlocked",
    validate("json", resetFromUnlockedRequestSchema),
    async (c) => {
      const { user } = getAuth(c);
      const { emailCode, ...change } = c.req.valid("json");
      const db = getDb(c.env);
      const ok = await verifyAndConsumeEmailCode(db, user.email, "sensitive_action", emailCode);
      if (!ok) throw new AppError("email_code_invalid", 400);
      return replacePassword(c, user, change, { via: "email_code" });
    },
  )
  .post("/recovery", validate("json", replaceRecoveryRequestSchema), async (c) => {
    const { user } = getAuth(c);
    const db = getDb(c.env);
    const body = c.req.valid("json");
    const now = Date.now();
    await runBatch(db, [
      db
        .update(users)
        .set({
          wrappedAkRec: body.wrappedAkRec,
          recoveryVerifier: await computeVerifier(c.var.config, body.recoveryAuthKey),
          updatedAt: now,
        })
        .where(eq(users.id, user.id)),
      auditStatement(db, user.id, "recovery_kit_regenerated", {}, now),
    ]);
    await sendSecurityNotice(c, user.email, "recovery_kit_regenerated");
    return c.json({ ok: true as const });
  })
  .post("/kdf-upgrade", validate("json", kdfUpgradeRequestSchema), async (c) => {
    const { user } = getAuth(c);
    const db = getDb(c.env);
    const { currentAuthKey, ...change } = c.req.valid("json");
    await requireCurrentAuthKey(c, user, currentAuthKey);
    // An upgrade never weakens the parameters (a stolen session must not downgrade the KDF).
    if (change.newKdf.mem < user.kdfMem || change.newKdf.ops < user.kdfOps) {
      throw new AppError("validation_error", 400, "KDF parameters cannot be weakened.");
    }
    const now = Date.now();
    // Same password, stronger parameters: other devices stay signed in.
    const { statement } = await buildPasswordUpdate(db, c.var.config, user, change, {
      bumpStamp: false,
      now,
    });
    await runBatch(db, [
      statement,
      auditStatement(
        db,
        user.id,
        "kdf_upgraded",
        { mem: change.newKdf.mem, ops: change.newKdf.ops },
        now,
      ),
    ]);
    return c.json({ ok: true as const });
  })

  // --- Sessions ----------------------------------------------------------------------------------------
  .get("/sessions", async (c) => {
    const { user, session } = getAuth(c);
    const rows = await getDb(c.env)
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id))
      .orderBy(desc(sessions.lastSeenAt));
    return c.json({
      sessions: rows.map((row) => ({
        id: row.id,
        userAgent: row.userAgent === "" ? null : row.userAgent,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        current: row.id === session.id,
      })),
    });
  })
  .delete("/sessions", async (c) => {
    const { user, session } = getAuth(c);
    const db = getDb(c.env);
    await runBatch(db, [
      destroyAllSessionsStatement(db, user.id, session.id),
      auditStatement(db, user.id, "sessions_revoked", { scope: "others" }),
    ]);
    return c.json({ ok: true as const });
  })
  .delete("/sessions/:id", validate("param", idParamsSchema), async (c) => {
    const { user, session } = getAuth(c);
    const { id } = c.req.valid("param");
    const db = getDb(c.env);
    const removed = await db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
      .returning({ id: sessions.id });
    if (removed.length === 0) throw new AppError("not_found", 404);
    if (id === session.id)
      c.header("Set-Cookie", clearSessionCookie(c.var.config), { append: true });
    return c.json({ ok: true as const });
  })

  // --- Login 2FA: TOTP ---------------------------------------------------------------------------------
  .post("/2fa/totp/setup", async (c) => {
    await requireEmptyBody(c);
    const { user } = getAuth(c);
    const db = getDb(c.env);
    if (user.totpSecretEnc) {
      throw new AppError("conflict", 409, "Authenticator app 2FA is already turned on.");
    }
    // The pending secret lives encrypted in a per-user `auth_challenges` row (kind `2fa`, payload
    // purpose `totp_setup`). `users.totp_secret_enc` is only written when the code is confirmed,
    // so "secret present" always means "TOTP enabled".
    const secret = generateTotpSecret();
    const row = await buildSingletonChallenge(
      user.id,
      "2fa",
      {
        purpose: TOTP_SETUP_PURPOSE,
        secretEnc: await encryptTotpSecret(c.var.config, user.id, secret),
      },
      SETUP_TTL_MS,
    );
    await runBatch(db, [...replaceSingleton(db, row)]);
    return c.json({ secret, otpauthUri: totpUri(user.email, secret) });
  })
  .post("/2fa/totp/enable", validate("json", totpEnableRequestSchema), async (c) => {
    const { user } = getAuth(c);
    const { code } = c.req.valid("json");
    const db = getDb(c.env);
    const config = c.var.config;
    if (user.totpSecretEnc) {
      throw new AppError("conflict", 409, "Authenticator app 2FA is already turned on.");
    }
    const limitKey = `totp-enable:user:${user.id}`;
    await assertNotLimited(c, db, limitKey, FAILURE_LIMIT, WINDOW_SECONDS);

    const pending = await findSingletonChallenge(db, "2fa", user.id);
    const payload = pending ? parsePayload(pending) : {};
    if (
      !pending ||
      payload.purpose !== TOTP_SETUP_PURPOSE ||
      typeof payload.secretEnc !== "string"
    ) {
      throw challengeInvalid("Start the authenticator setup again.");
    }
    const step = matchTotpStep(await decryptTotpSecret(config, user.id, payload.secretEnc), code);
    if (step === null) {
      await recordFailure(db, limitKey, FAILURE_LIMIT, WINDOW_SECONDS);
      throw new AppError("invalid_two_factor", 401);
    }

    const state = await loadTwoFactorState(db, user);
    const first = !state.enabled;
    const backup = first ? await buildBackupCodeSet(db, user.id) : null;
    const now = Date.now();
    await runBatch(db, [
      db
        .update(users)
        .set({ totpSecretEnc: payload.secretEnc, totpLastStep: step, updatedAt: now })
        .where(eq(users.id, user.id)),
      db.delete(authChallenges).where(eq(authChallenges.id, pending.id)),
      ...(backup ? [backup.deleteOld, backup.insertNew] : []),
      auditStatement(db, user.id, "2fa_enabled", { method: "totp" }, now),
    ]);
    await sendSecurityNotice(c, user.email, "two_factor_enabled");
    return c.json({ backupCodes: backup?.codes ?? null });
  })
  .post("/2fa/totp/disable", async (c) => {
    // `@pm/shared` currently types this body as empty; disabling needs a current code, so the
    // body is `{ method: "totp" | "backup_code", code }` (the recovery 2FA shape).
    const { user } = getAuth(c);
    const factor = await readOptionalJson(c, recoveryTwoFactorSchema);
    const db = getDb(c.env);
    if (!user.totpSecretEnc) {
      throw new AppError("conflict", 409, "Authenticator app 2FA is not turned on.");
    }
    await requireSecondFactor(c, user, factor);

    const state = await loadTwoFactorState(db, user);
    const last = state.passkeys === 0;
    const now = Date.now();
    await runBatch(db, [
      db
        .update(users)
        .set({ totpSecretEnc: null, totpLastStep: null, updatedAt: now })
        .where(eq(users.id, user.id)),
      ...(last ? [db.delete(backupCodes).where(eq(backupCodes.userId, user.id))] : []),
      auditStatement(db, user.id, last ? "2fa_disabled" : "totp_removed", { method: "totp" }, now),
    ]);
    await sendSecurityNotice(c, user.email, last ? "two_factor_disabled" : "totp_removed");
    return c.json({ ok: true as const });
  })

  // --- Login 2FA: passkeys -----------------------------------------------------------------------------
  .get("/2fa/webauthn", async (c) => {
    const { user } = getAuth(c);
    const rows = await getDb(c.env)
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id))
      .orderBy(asc(webauthnCredentials.createdAt));
    return c.json({
      credentials: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
      })),
    });
  })
  .post("/2fa/webauthn/register/options", async (c) => {
    await requireEmptyBody(c);
    const { user } = getAuth(c);
    const db = getDb(c.env);
    const existing = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    const options = await registrationOptions(c.var.config, user, existing);
    const row = await buildSingletonChallenge(
      user.id,
      "webauthn_register",
      { challenge: options.challenge },
      WEBAUTHN_TTL_MS,
    );
    await runBatch(db, [...replaceSingleton(db, row)]);
    return c.json({ options });
  })
  .post(
    "/2fa/webauthn/register/verify",
    validate("json", webauthnRegisterVerifyRequestSchema),
    async (c) => {
      const { user } = getAuth(c);
      const { name, credential } = c.req.valid("json");
      const db = getDb(c.env);
      const limitKey = `webauthn-register:user:${user.id}`;
      await assertNotLimited(c, db, limitKey, FAILURE_LIMIT, WINDOW_SECONDS);

      const pending = await findSingletonChallenge(db, "webauthn_register", user.id);
      const expected = pending ? parsePayload(pending).challenge : undefined;
      if (!pending || typeof expected !== "string") throw challengeInvalid();

      const verified = await verifyRegistration(c.var.config, credential, expected);
      if (!verified) {
        await recordFailure(db, limitKey, FAILURE_LIMIT, WINDOW_SECONDS);
        throw new AppError("validation_error", 400, "The passkey could not be verified.");
      }

      const state = await loadTwoFactorState(db, user);
      const first = !state.enabled;
      const backup = first ? await buildBackupCodeSet(db, user.id) : null;
      const now = Date.now();
      const id = newId();
      try {
        await runBatch(db, [
          db.insert(webauthnCredentials).values({
            id,
            userId: user.id,
            credentialId: verified.credentialId,
            publicKey: verified.publicKey,
            counter: verified.counter,
            transports: JSON.stringify(verified.transports),
            name,
            createdAt: now,
            lastUsedAt: null,
          }),
          db.delete(authChallenges).where(eq(authChallenges.id, pending.id)),
          ...(backup ? [backup.deleteOld, backup.insertNew] : []),
          auditStatement(db, user.id, "passkey_added", {}, now),
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError("conflict", 409, "This passkey is already registered.");
        }
        throw error;
      }
      await sendSecurityNotice(c, user.email, first ? "two_factor_enabled" : "passkey_added");
      return c.json(
        {
          credential: { id, name, createdAt: now, lastUsedAt: null },
          backupCodes: backup?.codes ?? null,
        },
        201,
      );
    },
  )
  .delete("/2fa/webauthn/:id", validate("param", idParamsSchema), async (c) => {
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const db = getDb(c.env);
    const owned = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    if (!owned.some((row) => row.id === id)) throw new AppError("not_found", 404);
    const last = owned.length === 1 && user.totpSecretEnc === null;
    const now = Date.now();
    await runBatch(db, [
      db
        .delete(webauthnCredentials)
        .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, user.id))),
      ...(last ? [db.delete(backupCodes).where(eq(backupCodes.userId, user.id))] : []),
      auditStatement(db, user.id, "passkey_removed", {}, now),
    ]);
    await sendSecurityNotice(c, user.email, last ? "two_factor_disabled" : "passkey_removed");
    return c.json({ ok: true as const });
  })

  // --- Backup codes --------------------------------------------------------------------------------------
  .post("/2fa/backup-codes", async (c) => {
    await requireEmptyBody(c);
    const { user } = getAuth(c);
    const db = getDb(c.env);
    const state = await loadTwoFactorState(db, user);
    if (!state.enabled) {
      throw new AppError("conflict", 409, "Turn on two-factor authentication first.");
    }
    const backup = await buildBackupCodeSet(db, user.id);
    await runBatch(db, [
      backup.deleteOld,
      backup.insertNew,
      auditStatement(db, user.id, "backup_codes_regenerated"),
    ]);
    return c.json({ backupCodes: backup.codes });
  })

  // --- Activity, settings, deletion ------------------------------------------------------------------------
  .get("/activity", validate("query", activityQuerySchema), async (c) => {
    const { user } = getAuth(c);
    const { limit, before } = c.req.valid("query");
    const rows = await getDb(c.env)
      .select()
      .from(auditEvents)
      .where(
        before === undefined
          ? eq(auditEvents.userId, user.id)
          : and(eq(auditEvents.userId, user.id), lt(auditEvents.createdAt, before)),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit);
    return c.json({
      events: rows.map((row) => ({
        id: row.id,
        event: row.event,
        meta: parseMeta(row.meta),
        createdAt: row.createdAt,
      })),
    });
  })
  .patch("/settings", validate("json", updateSettingsRequestSchema), async (c) => {
    const { user } = getAuth(c);
    const settings = { ...parseSettings(user.settings), ...c.req.valid("json") };
    await getDb(c.env)
      .update(users)
      .set({ settings: JSON.stringify(settings), updatedAt: Date.now() })
      .where(eq(users.id, user.id));
    return c.json({ settings });
  })
  .delete("/", validate("json", deleteAccountRequestSchema), async (c) => {
    const { user } = getAuth(c);
    const { currentAuthKey, emailCode } = c.req.valid("json");
    const db = getDb(c.env);
    await requireCurrentAuthKey(c, user, currentAuthKey);
    if (user.role === "admin" && user.status === "active") {
      const other = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, user.id)))
        .limit(1)
        .get();
      if (!other) throw new AppError("last_admin", 409);
    }
    const ok = await verifyAndConsumeEmailCode(db, user.email, "sensitive_action", emailCode);
    if (!ok) throw new AppError("email_code_invalid", 400);

    await runBatch(db, [...deleteUserStatements(db, user.id)]);
    c.header("Set-Cookie", clearSessionCookie(c.var.config), { append: true });
    return c.json({ ok: true as const });
  });

function parseMeta(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
