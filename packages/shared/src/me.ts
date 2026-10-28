import { z } from "zod";
import {
  AUTO_LOCK_MINUTES_DEFAULT,
  AUTO_LOCK_MINUTES_MAX,
  AUTO_LOCK_MINUTES_MIN,
  THEMES,
  USER_ROLES,
} from "./constants.ts";
import {
  backupCodeSchema,
  base64urlSchema,
  bytes32Schema,
  emailCodeSchema,
  emailSchema,
  emptyRequestSchema,
  kdfParamsSchema,
  okResponseSchema,
  salt16Schema,
  smallEnvelopeSchema,
  timestampSchema,
  totpCodeSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

// --- Settings ----------------------------------------------------------------------------------

/** Non-sensitive per-user settings stored as JSON on the server (PLAN.md 12 `users.settings`). */
export const userSettingsSchema = z.strictObject({
  autoLockMinutes: z.int().min(AUTO_LOCK_MINUTES_MIN).max(AUTO_LOCK_MINUTES_MAX),
  theme: z.enum(THEMES),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  autoLockMinutes: AUTO_LOCK_MINUTES_DEFAULT,
  theme: "system",
};

// --- Shared account material (contract.md) ------------------------------------------------------

/** What the client needs to unlock (response of `GET /me/keys`, part of the login response). */
export const keyBundleSchema = z.strictObject({
  userId: uuidSchema,
  kdf: kdfParamsSchema,
  salt: salt16Schema,
  wrappedAkPw: smallEnvelopeSchema,
  publicKey: bytes32Schema,
  encryptedPrivateKey: smallEnvelopeSchema,
  keyGeneration: versionSchema,
});
export type KeyBundle = z.infer<typeof keyBundleSchema>;

/**
 * New password material produced by the client for a password change, forgot-password recovery,
 * reset-from-unlocked-device and KDF upgrade. A fresh salt is always generated.
 */
export const passwordChangeSchema = z.strictObject({
  newSalt: salt16Schema,
  newKdf: kdfParamsSchema,
  newAuthKey: bytes32Schema,
  newWrappedAk: smallEnvelopeSchema,
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

/** Replacement recovery kit (new phrase): AK wrapped under the new recovery key plus its verifier. */
export const recoveryKitReplaceSchema = z.strictObject({
  wrappedAkRec: smallEnvelopeSchema,
  recoveryAuthKey: bytes32Schema,
});
export type RecoveryKitReplace = z.infer<typeof recoveryKitReplaceSchema>;

/** Profile summary returned by login, accept-invite and `GET /me`. */
export const meSummarySchema = z.strictObject({
  id: uuidSchema,
  email: emailSchema,
  role: z.enum(USER_ROLES),
  twoFactor: z.strictObject({
    totp: z.boolean(),
    /** Number of registered passkeys. */
    webauthn: z.int().nonnegative(),
  }),
  settings: userSettingsSchema,
});
export type MeSummary = z.infer<typeof meSummarySchema>;

// --- GET /me, GET /me/keys ---------------------------------------------------------------------

export const meResponseSchema = z.strictObject({ user: meSummarySchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const meKeysResponseSchema = keyBundleSchema;
export type MeKeysResponse = z.infer<typeof meKeysResponseSchema>;

// --- Sensitive-action email code ---------------------------------------------------------------

/**
 * `POST /me/email-code`: email a `sensitive_action` code to the signed-in user. Added to the
 * plan's API because `reset-from-unlocked` and `DELETE /me` need a code and `/auth/email/start`
 * only serves the signed-out purposes.
 */
export const meEmailCodeRequestSchema = emptyRequestSchema;
export type MeEmailCodeRequest = z.infer<typeof meEmailCodeRequestSchema>;
export const meEmailCodeResponseSchema = okResponseSchema;
export type MeEmailCodeResponse = z.infer<typeof meEmailCodeResponseSchema>;

// --- Password / recovery / KDF -----------------------------------------------------------------

/** `POST /me/password` (PLAN.md 10.4). Server bumps the security stamp and re-issues the session. */
export const changePasswordRequestSchema = z.strictObject({
  currentAuthKey: bytes32Schema,
  ...passwordChangeSchema.shape,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export const changePasswordResponseSchema = okResponseSchema;
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

/** `POST /me/password/reset-from-unlocked` (PLAN.md 10.5 B), needs a `sensitive_action` code. */
export const resetFromUnlockedRequestSchema = z.strictObject({
  emailCode: emailCodeSchema,
  ...passwordChangeSchema.shape,
});
export type ResetFromUnlockedRequest = z.infer<typeof resetFromUnlockedRequestSchema>;
export const resetFromUnlockedResponseSchema = okResponseSchema;
export type ResetFromUnlockedResponse = z.infer<typeof resetFromUnlockedResponseSchema>;

/** `POST /me/recovery`: replace the recovery kit. */
export const replaceRecoveryRequestSchema = recoveryKitReplaceSchema;
export type ReplaceRecoveryRequest = z.infer<typeof replaceRecoveryRequestSchema>;
export const replaceRecoveryResponseSchema = okResponseSchema;
export type ReplaceRecoveryResponse = z.infer<typeof replaceRecoveryResponseSchema>;

/**
 * `POST /me/kdf-upgrade`: same material as a password change (same password, stronger params,
 * fresh salt), authenticated with the current authKey.
 */
export const kdfUpgradeRequestSchema = changePasswordRequestSchema;
export type KdfUpgradeRequest = z.infer<typeof kdfUpgradeRequestSchema>;
export const kdfUpgradeResponseSchema = okResponseSchema;
export type KdfUpgradeResponse = z.infer<typeof kdfUpgradeResponseSchema>;

// --- Sessions ----------------------------------------------------------------------------------

export const sessionInfoSchema = z.strictObject({
  id: uuidSchema,
  userAgent: z.string().nullable(),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  expiresAt: timestampSchema,
  /** True for the session making the request. */
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** `GET /me/sessions` */
export const listSessionsResponseSchema = z.strictObject({ sessions: z.array(sessionInfoSchema) });
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

/** `DELETE /me/sessions/:id` and `DELETE /me/sessions` (revokes every session except the current one). */
export const revokeSessionResponseSchema = okResponseSchema;
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;

// --- Login 2FA: TOTP ---------------------------------------------------------------------------

/** `POST /me/2fa/totp/setup`: server generates a pending secret. The client renders the QR code. */
export const totpSetupRequestSchema = emptyRequestSchema;
export type TotpSetupRequest = z.infer<typeof totpSetupRequestSchema>;
export const totpSetupResponseSchema = z.strictObject({
  /** Base32 secret, for manual entry. */
  secret: z.string().min(16).max(128),
  /** `otpauth://totp/...` URI to render as a QR code. */
  otpauthUri: z.string().max(2048),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

/** `POST /me/2fa/totp/enable`: confirm with a code from the authenticator app. */
export const totpEnableRequestSchema = z.strictObject({ code: totpCodeSchema });
export type TotpEnableRequest = z.infer<typeof totpEnableRequestSchema>;
export const totpEnableResponseSchema = z.strictObject({
  /** Present (shown once) when this enabling generated the first set of backup codes, else null. */
  backupCodes: z.array(backupCodeSchema).nullable(),
});
export type TotpEnableResponse = z.infer<typeof totpEnableResponseSchema>;

/** `POST /me/2fa/totp/disable` */
export const totpDisableRequestSchema = emptyRequestSchema;
export type TotpDisableRequest = z.infer<typeof totpDisableRequestSchema>;
export const totpDisableResponseSchema = okResponseSchema;
export type TotpDisableResponse = z.infer<typeof totpDisableResponseSchema>;

// --- Login 2FA: passkeys (WebAuthn) ------------------------------------------------------------

/**
 * WebAuthn JSON structures follow the W3C `*JSON` types. They are validated structurally here
 * and in depth by the server's WebAuthn library, so unknown members are kept (loose objects).
 */
export const webauthnCredentialDescriptorSchema = z.looseObject({
  id: base64urlSchema,
  type: z.literal("public-key"),
  transports: z.array(z.string()).optional(),
});

/** `PublicKeyCredentialCreationOptionsJSON` */
export const webauthnCreationOptionsSchema = z.looseObject({
  challenge: base64urlSchema,
  rp: z.looseObject({ id: z.string().optional(), name: z.string() }),
  user: z.looseObject({ id: base64urlSchema, name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.looseObject({ type: z.literal("public-key"), alg: z.int() })),
  timeout: z.int().optional(),
  excludeCredentials: z.array(webauthnCredentialDescriptorSchema).optional(),
  attestation: z.string().optional(),
});
export type WebauthnCreationOptions = z.infer<typeof webauthnCreationOptionsSchema>;

/** `PublicKeyCredentialRequestOptionsJSON` */
export const webauthnRequestOptionsSchema = z.looseObject({
  challenge: base64urlSchema,
  rpId: z.string().optional(),
  timeout: z.int().optional(),
  allowCredentials: z.array(webauthnCredentialDescriptorSchema).optional(),
  userVerification: z.string().optional(),
});
export type WebauthnRequestOptions = z.infer<typeof webauthnRequestOptionsSchema>;

/** `RegistrationResponseJSON` */
export const webauthnRegistrationCredentialSchema = z.looseObject({
  id: base64urlSchema,
  rawId: base64urlSchema,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: base64urlSchema,
    attestationObject: base64urlSchema,
    transports: z.array(z.string()).optional(),
  }),
  clientExtensionResults: z.looseObject({}).optional(),
  authenticatorAttachment: z.string().optional(),
});
export type WebauthnRegistrationCredential = z.infer<typeof webauthnRegistrationCredentialSchema>;

/** `AuthenticationResponseJSON` */
export const webauthnAssertionSchema = z.looseObject({
  id: base64urlSchema,
  rawId: base64urlSchema,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: base64urlSchema,
    authenticatorData: base64urlSchema,
    signature: base64urlSchema,
    userHandle: base64urlSchema.optional(),
  }),
  clientExtensionResults: z.looseObject({}).optional(),
  authenticatorAttachment: z.string().optional(),
});
export type WebauthnAssertion = z.infer<typeof webauthnAssertionSchema>;

export const passkeyInfoSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
});
export type PasskeyInfo = z.infer<typeof passkeyInfoSchema>;

/** `GET /me/2fa/webauthn` (added to the plan: the settings page lists passkeys by name). */
export const listPasskeysResponseSchema = z.strictObject({
  credentials: z.array(passkeyInfoSchema),
});
export type ListPasskeysResponse = z.infer<typeof listPasskeysResponseSchema>;

/** `POST /me/2fa/webauthn/register/options` */
export const webauthnRegisterOptionsRequestSchema = emptyRequestSchema;
export type WebauthnRegisterOptionsRequest = z.infer<typeof webauthnRegisterOptionsRequestSchema>;
export const webauthnRegisterOptionsResponseSchema = z.strictObject({
  options: webauthnCreationOptionsSchema,
});
export type WebauthnRegisterOptionsResponse = z.infer<typeof webauthnRegisterOptionsResponseSchema>;

/** `POST /me/2fa/webauthn/register/verify` */
export const webauthnRegisterVerifyRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  credential: webauthnRegistrationCredentialSchema,
});
export type WebauthnRegisterVerifyRequest = z.infer<typeof webauthnRegisterVerifyRequestSchema>;
export const webauthnRegisterVerifyResponseSchema = z.strictObject({
  credential: passkeyInfoSchema,
  /** Present (shown once) when this registration generated the first set of backup codes. */
  backupCodes: z.array(backupCodeSchema).nullable(),
});
export type WebauthnRegisterVerifyResponse = z.infer<typeof webauthnRegisterVerifyResponseSchema>;

/** `DELETE /me/2fa/webauthn/:id` */
export const webauthnRemoveResponseSchema = okResponseSchema;
export type WebauthnRemoveResponse = z.infer<typeof webauthnRemoveResponseSchema>;

// --- Backup codes ------------------------------------------------------------------------------

/** `POST /me/2fa/backup-codes`: regenerate (invalidates all previous codes). */
export const backupCodesRequestSchema = emptyRequestSchema;
export type BackupCodesRequest = z.infer<typeof backupCodesRequestSchema>;
export const backupCodesResponseSchema = z.strictObject({
  backupCodes: z.array(backupCodeSchema),
});
export type BackupCodesResponse = z.infer<typeof backupCodesResponseSchema>;

// --- Activity ----------------------------------------------------------------------------------

/** `GET /me/activity?limit=&before=` (query strings are coerced). */
export const activityQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Return events strictly older than this timestamp (for paging). */
  before: z.coerce.number().int().nonnegative().optional(),
});
export type ActivityQuery = z.input<typeof activityQuerySchema>;

export const auditEventSchema = z.strictObject({
  id: uuidSchema,
  /** e.g. `login`, `password_changed`, `recovery_used`, `share_created`, `2fa_enabled`. */
  event: z.string(),
  /** Non-secret context (never keys or codes). */
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: timestampSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const activityResponseSchema = z.strictObject({ events: z.array(auditEventSchema) });
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

// --- Settings / delete -------------------------------------------------------------------------

/** `PATCH /me/settings`: any subset, at least one key. */
export const updateSettingsRequestSchema = userSettingsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one setting");
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
export const updateSettingsResponseSchema = z.strictObject({ settings: userSettingsSchema });
export type UpdateSettingsResponse = z.infer<typeof updateSettingsResponseSchema>;

/** `DELETE /me`: needs the password proof and a `sensitive_action` email code. */
export const deleteAccountRequestSchema = z.strictObject({
  currentAuthKey: bytes32Schema,
  emailCode: emailCodeSchema,
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
export const deleteAccountResponseSchema = okResponseSchema;
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
