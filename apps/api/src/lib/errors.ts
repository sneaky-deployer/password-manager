import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, z } from "zod";
import type { AppEnv } from "../env.ts";

/** Every error code the API can return (snake_case, stable: the web app switches on these). */
export const ERROR_CODES = [
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "revision_conflict",
  "rate_limited",
  "invalid_credentials",
  "two_factor_required",
  "invalid_two_factor",
  "invite_invalid",
  "email_taken",
  "email_code_invalid",
  "account_disabled",
  "quota_exceeded",
  "server_misconfigured",
  "setup_not_available",
  "last_admin",
  "item_too_large",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  validation_error: "The request is invalid.",
  unauthorized: "You are not signed in.",
  forbidden: "You are not allowed to do that.",
  not_found: "Not found",
  conflict: "The request conflicts with the current state.",
  revision_conflict: "This item was changed elsewhere. Reload it and try again.",
  rate_limited: "Too many requests. Try again later.",
  invalid_credentials: "Incorrect email or password.",
  two_factor_required: "Two-factor authentication is required.",
  invalid_two_factor: "The two-factor code is not valid.",
  invite_invalid: "This invitation is invalid or has expired.",
  email_taken: "An account or invitation already exists for this email.",
  email_code_invalid: "The code is invalid or has expired.",
  account_disabled: "This account is disabled.",
  quota_exceeded: "The service has reached its daily limit. Try again later.",
  server_misconfigured: "The server is not configured correctly.",
  setup_not_available: "Setup is not available.",
  last_admin: "The last administrator cannot be removed or demoted.",
  item_too_large: "The item is too large.",
  internal_error: "Internal server error.",
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message?: string, details?: unknown): ErrorBody {
  const error: ErrorBody["error"] = { code, message: message ?? DEFAULT_MESSAGES[code] };
  if (details !== undefined) error.details = details;
  return { error };
}

/**
 * Throw from any handler or middleware to produce `{ error: { code, message, details? } }` with
 * the given HTTP status. `message` defaults to a generic text for the code. Never put secrets or
 * internal state in `message` or `details`: both are sent to the client.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: ContentfulStatusCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 400 `validation_error` with zod's flattened `{ formErrors, fieldErrors }` as details. */
export function validationError(error: z.core.$ZodError): AppError {
  return new AppError("validation_error", 400, undefined, z.flattenError(error));
}

/** Walks `cause` so wrapped driver errors (drizzle wraps D1 errors) are still recognised. */
function errorChain(err: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

const QUOTA_PATTERN =
  /daily (read|write|query|row)?\s*limit|quota|free tier|exceeded.*limit|limit.*exceeded/i;

/** True for D1 failures caused by the free plan's daily limits (PLAN.md section 4). */
export function isQuotaError(err: unknown): boolean {
  return errorChain(err).some((message) => QUOTA_PATTERN.test(message));
}

/** True for a SQLite UNIQUE / PRIMARY KEY violation (e.g. to map to `email_taken` or `conflict`). */
export function isUniqueViolation(err: unknown): boolean {
  return errorChain(err).some((message) => /UNIQUE constraint failed/i.test(message));
}

const HTTP_STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: "validation_error",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "item_too_large",
  429: "rate_limited",
};

function respond(c: Context<AppEnv>, status: ContentfulStatusCode, body: ErrorBody) {
  return c.json(body, status);
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) {
    return respond(c, err.status, errorBody(err.code, err.message, err.details));
  }
  if (err instanceof ZodError) {
    const e = validationError(err);
    return respond(c, e.status, errorBody(e.code, e.message, e.details));
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    const code =
      HTTP_STATUS_CODES[status] ?? (status >= 500 ? "internal_error" : "validation_error");
    // HTTPException messages come from Hono itself (e.g. "Malformed JSON in request body").
    return respond(c, status, errorBody(code, status >= 500 ? undefined : err.message));
  }
  if (isQuotaError(err)) {
    console.error("D1 quota exceeded");
    return respond(c, 503, errorBody("quota_exceeded"));
  }
  // Never log request data: only the error's name and message.
  console.error(`unhandled error: ${err.name}: ${err.message}`);
  // Internal messages never reach clients in production; other environments get a hint.
  const detail =
    c.env?.ENVIRONMENT === "production" ? undefined : { cause: `${err.name}: ${err.message}` };
  return respond(c, 500, errorBody("internal_error", undefined, detail));
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  respond(c, 404, errorBody("not_found"));
