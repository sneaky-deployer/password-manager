import { z } from "zod";

/** Machine readable error codes returned in `{ error: { code } }` (PLAN.md 13). */
export const ERROR_CODES = {
  validation_error: "validation_error",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  origin_mismatch: "origin_mismatch",
  not_found: "not_found",
  conflict: "conflict",
  revision_conflict: "revision_conflict",
  rate_limited: "rate_limited",
  invalid_credentials: "invalid_credentials",
  two_factor_required: "two_factor_required",
  invalid_two_factor: "invalid_two_factor",
  challenge_invalid: "challenge_invalid",
  invite_invalid: "invite_invalid",
  email_taken: "email_taken",
  email_code_invalid: "email_code_invalid",
  account_disabled: "account_disabled",
  quota_exceeded: "quota_exceeded",
  server_misconfigured: "server_misconfigured",
  setup_not_available: "setup_not_available",
  last_admin: "last_admin",
  item_too_large: "item_too_large",
  rotation_pending: "rotation_pending",
  key_version_mismatch: "key_version_mismatch",
  internal_error: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** Default HTTP status for each code, so the API and the client agree. */
export const ERROR_HTTP_STATUS = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  origin_mismatch: 403,
  not_found: 404,
  conflict: 409,
  revision_conflict: 409,
  rate_limited: 429,
  invalid_credentials: 401,
  two_factor_required: 401,
  invalid_two_factor: 401,
  challenge_invalid: 400,
  invite_invalid: 410,
  email_taken: 409,
  email_code_invalid: 400,
  account_disabled: 403,
  quota_exceeded: 503,
  server_misconfigured: 500,
  setup_not_available: 404,
  last_admin: 409,
  item_too_large: 413,
  rotation_pending: 409,
  key_version_mismatch: 409,
  internal_error: 500,
} as const satisfies Record<ErrorCode, number>;

/**
 * Error body: `{ error: { code, message, details? } }`. `details` is optional structured data,
 * e.g. zod issues for `validation_error`, `{ methods }` for `two_factor_required`,
 * `{ retryAfterSeconds }` for `rate_limited`, `{ currentRevision }` for `revision_conflict`.
 * It never carries secrets.
 */
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
