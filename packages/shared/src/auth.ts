import { z } from "zod";
import { INVITE_KINDS, PUBLIC_EMAIL_CODE_PURPOSES, TWO_FACTOR_METHODS } from "./constants.ts";
import {
  keyBundleSchema,
  meSummarySchema,
  passwordChangeSchema,
  webauthnAssertionSchema,
  webauthnRequestOptionsSchema,
} from "./me.ts";
import {
  backupCodeSchema,
  bytes32Schema,
  emailCodeSchema,
  emailSchema,
  emptyRequestSchema,
  kdfParamsSchema,
  metaEnvelopeSchema,
  okResponseSchema,
  salt16Schema,
  sealedBoxSchema,
  smallEnvelopeSchema,
  timestampSchema,
  tokenSchema,
  totpCodeSchema,
  uuidSchema,
} from "./primitives.ts";

// --- Account creation material (contract.md) -----------------------------------------------------

/**
 * Everything the client generates when creating an account: key material plus the default vault.
 * Used by `accept-invite` and by `reset-account` (PLAN.md 10.1, 10.5 D).
 */
export const accountCreationSchema = z.strictObject({
  user: z.strictObject({
    /** Client-generated; it is part of several AAD strings. */
    id: uuidSchema,
    kdf: kdfParamsSchema,
    salt: salt16Schema,
    /** Server stores `HMAC(AUTH_PEPPER, authKey)`. */
    authKey: bytes32Schema,
    wrappedAkPw: smallEnvelopeSchema,
    wrappedAkRec: smallEnvelopeSchema,
    /** Server stores `HMAC(AUTH_PEPPER, recoveryAuthKey)`. */
    recoveryAuthKey: bytes32Schema,
    /** X25519 public key. */
    publicKey: bytes32Schema,
    encryptedPrivateKey: smallEnvelopeSchema,
  }),
  vault: z.strictObject({
    id: uuidSchema,
    keyVersion: z.literal(1),
    encryptedMeta: metaEnvelopeSchema,
    /** Vault key sealed to the user's own public key. */
    sealedKey: sealedBoxSchema,
  }),
});
export type AccountCreation = z.infer<typeof accountCreationSchema>;

// --- Setup (PLAN.md 10.0) -----------------------------------------------------------------------

/** `GET /setup/status` */
export const setupStatusResponseSchema = z.strictObject({ needsSetup: z.boolean() });
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;

/** `POST /setup/start` (no body). Responds 404 `setup_not_available` once an admin exists. */
export const setupStartRequestSchema = emptyRequestSchema;
export type SetupStartRequest = z.infer<typeof setupStartRequestSchema>;
export const setupStartResponseSchema = okResponseSchema;
export type SetupStartResponse = z.infer<typeof setupStartResponseSchema>;

// --- Invites (PLAN.md 10.1) ---------------------------------------------------------------------

/** `POST /invites/inspect` */
export const inspectInviteRequestSchema = z.strictObject({ token: tokenSchema });
export type InspectInviteRequest = z.infer<typeof inspectInviteRequestSchema>;
export const inspectInviteResponseSchema = z.strictObject({
  email: emailSchema,
  /** Email of the inviting admin; null for the bootstrap admin. */
  invitedBy: emailSchema.nullable(),
  kind: z.enum(INVITE_KINDS),
  expiresAt: timestampSchema,
});
export type InspectInviteResponse = z.infer<typeof inspectInviteResponseSchema>;

/** `POST /auth/accept-invite`: `{ token }` plus the account creation material. */
export const acceptInviteRequestSchema = z.strictObject({
  token: tokenSchema,
  ...accountCreationSchema.shape,
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
/** Starts a session (cookie) and returns the profile. */
export const acceptInviteResponseSchema = z.strictObject({ user: meSummarySchema });
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;

// --- Email codes --------------------------------------------------------------------------------

/**
 * `POST /auth/email/start`: send a code for `recovery` or `reset_account`. Always answers `ok`
 * (even for unknown emails) so it cannot be used to discover accounts.
 */
export const emailStartRequestSchema = z.strictObject({
  email: emailSchema,
  purpose: z.enum(PUBLIC_EMAIL_CODE_PURPOSES),
});
export type EmailStartRequest = z.infer<typeof emailStartRequestSchema>;
export const emailStartResponseSchema = okResponseSchema;
export type EmailStartResponse = z.infer<typeof emailStartResponseSchema>;

// --- Prelogin / login ---------------------------------------------------------------------------

/** `POST /auth/prelogin`. Unknown emails get a deterministic fake salt and default params. */
export const preloginRequestSchema = z.strictObject({ email: emailSchema });
export type PreloginRequest = z.infer<typeof preloginRequestSchema>;
export const preloginResponseSchema = z.strictObject({
  kdf: kdfParamsSchema,
  salt: salt16Schema,
});
export type PreloginResponse = z.infer<typeof preloginResponseSchema>;

/** `POST /auth/login` */
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  authKey: bytes32Schema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Session created: profile plus the key bundle to unlock with. */
export const loginOkResponseSchema = z.strictObject({
  status: z.literal("ok"),
  user: meSummarySchema,
  keys: keyBundleSchema,
});
export type LoginOkResponse = z.infer<typeof loginOkResponseSchema>;

export const twoFactorRequiredResponseSchema = z.strictObject({
  status: z.literal("two_factor_required"),
  /** Random, valid 5 minutes. Pass it to `/auth/2fa/verify` and `/auth/webauthn/options`. */
  challengeToken: tokenSchema,
  methods: z.array(z.enum(TWO_FACTOR_METHODS)).min(1),
});
export type TwoFactorRequiredResponse = z.infer<typeof twoFactorRequiredResponseSchema>;

export const loginResponseSchema = z.discriminatedUnion("status", [
  loginOkResponseSchema,
  twoFactorRequiredResponseSchema,
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

// --- Login 2FA ----------------------------------------------------------------------------------

/**
 * `POST /auth/2fa/verify`: discriminated on `method`. (PLAN.md 10.2 sketches three optional
 * members `totp | webauthnAssertion | backupCode`; one tagged member per method is stricter.)
 */
export const twoFactorVerifyRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    challengeToken: tokenSchema,
    method: z.literal("totp"),
    code: totpCodeSchema,
  }),
  z.strictObject({
    challengeToken: tokenSchema,
    method: z.literal("webauthn"),
    assertion: webauthnAssertionSchema,
  }),
  z.strictObject({
    challengeToken: tokenSchema,
    method: z.literal("backup_code"),
    code: backupCodeSchema,
  }),
]);
export type TwoFactorVerifyRequest = z.infer<typeof twoFactorVerifyRequestSchema>;
export const twoFactorVerifyResponseSchema = loginOkResponseSchema;
export type TwoFactorVerifyResponse = z.infer<typeof twoFactorVerifyResponseSchema>;

/** `POST /auth/webauthn/options`: assertion options for a pending login challenge. */
export const webauthnOptionsRequestSchema = z.strictObject({ challengeToken: tokenSchema });
export type WebauthnOptionsRequest = z.infer<typeof webauthnOptionsRequestSchema>;
export const webauthnOptionsResponseSchema = z.strictObject({
  options: webauthnRequestOptionsSchema,
});
export type WebauthnOptionsResponse = z.infer<typeof webauthnOptionsResponseSchema>;

// --- Recovery (PLAN.md 10.5 A) ------------------------------------------------------------------

/**
 * Second factor accepted on the recovery path. Passkeys are not offered here (there is no login
 * challenge to bind an assertion to); users with passkeys use a backup code.
 */
export const recoveryTwoFactorSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("totp"), code: totpCodeSchema }),
  z.strictObject({ method: z.literal("backup_code"), code: backupCodeSchema }),
]);
export type RecoveryTwoFactor = z.infer<typeof recoveryTwoFactorSchema>;

/**
 * `POST /auth/recovery/start`. If 2FA is on and `twoFactor` is missing the server answers
 * `401 two_factor_required` with `details.methods`.
 */
export const recoveryStartRequestSchema = z.strictObject({
  email: emailSchema,
  emailCode: emailCodeSchema,
  recoveryAuthKey: bytes32Schema,
  twoFactor: recoveryTwoFactorSchema.optional(),
});
export type RecoveryStartRequest = z.infer<typeof recoveryStartRequestSchema>;
export const recoveryStartResponseSchema = z.strictObject({
  userId: uuidSchema,
  wrappedAkRec: smallEnvelopeSchema,
  /** Valid 10 minutes; authorises exactly one `recovery/complete`. */
  recoveryToken: tokenSchema,
});
export type RecoveryStartResponse = z.infer<typeof recoveryStartResponseSchema>;

/** `POST /auth/recovery/complete` */
export const recoveryCompleteRequestSchema = z.strictObject({
  recoveryToken: tokenSchema,
  ...passwordChangeSchema.shape,
});
export type RecoveryCompleteRequest = z.infer<typeof recoveryCompleteRequestSchema>;
/** Starts a session so the client can immediately offer a new recovery kit. */
export const recoveryCompleteResponseSchema = loginOkResponseSchema;
export type RecoveryCompleteResponse = z.infer<typeof recoveryCompleteResponseSchema>;

// --- Reset account (PLAN.md 10.5 D) --------------------------------------------------------------

/**
 * `POST /auth/reset-account`: last resort, data is wiped. The client generates entirely new
 * keys (new user id included) and a new empty default vault, exactly as for a fresh account.
 */
export const resetAccountRequestSchema = z.strictObject({
  email: emailSchema,
  emailCode: emailCodeSchema,
  ...accountCreationSchema.shape,
});
export type ResetAccountRequest = z.infer<typeof resetAccountRequestSchema>;
/** Starts a session and returns the profile. */
export const resetAccountResponseSchema = z.strictObject({ user: meSummarySchema });
export type ResetAccountResponse = z.infer<typeof resetAccountResponseSchema>;

// --- Logout -------------------------------------------------------------------------------------

/** `POST /auth/logout` */
export const logoutRequestSchema = emptyRequestSchema;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export const logoutResponseSchema = okResponseSchema;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
