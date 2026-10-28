import { isCryptoError } from "../crypto-worker/client.ts";
import { CRYPTO_ERROR } from "../crypto-worker/protocol.ts";
import { ApiError } from "./api.ts";

function retryAfterSeconds(details: unknown): number | null {
  if (typeof details === "object" && details !== null && "retryAfterSeconds" in details) {
    const value = (details as { retryAfterSeconds: unknown }).retryAfterSeconds;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  return null;
}

/** Calm, specific-enough text for any error. Never includes server internals or secrets. */
export function describeError(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "network_error":
        return "Cannot reach the server. Check your connection and try again.";
      case "rate_limited": {
        const seconds = retryAfterSeconds(error.details);
        return seconds
          ? `Too many attempts. Try again in ${formatWait(seconds)}.`
          : "Too many attempts. Wait a few minutes and try again.";
      }
      case "invalid_credentials":
        return "Incorrect email or password.";
      case "email_code_invalid":
        return "That code is wrong or has expired. Request a new one.";
      case "invalid_two_factor":
        return "That verification code is wrong.";
      case "challenge_invalid":
        return "Your sign-in attempt expired. Start again.";
      case "invite_invalid":
        return "This invite link is invalid or has expired.";
      case "account_disabled":
        return "This account is disabled. Contact your administrator.";
      case "quota_exceeded":
        return "The service is over its daily limit. Try again tomorrow.";
      case "last_admin":
        return "There must be at least one active admin.";
      case "email_taken":
        return "That email already has an account or a pending invite.";
      case "origin_mismatch":
        return "The request was blocked because it came from a different origin. Reload the page.";
      case "forbidden":
        return "You are not allowed to do that.";
      case "invalid_response":
        return "The server sent an unexpected answer. Try again.";
      default:
        return error.message || fallback;
    }
  }
  if (isCryptoError(error)) {
    switch (error.code) {
      case CRYPTO_ERROR.wrongPassword:
        return "Wrong password.";
      case CRYPTO_ERROR.invalidRecoveryPhrase:
        return "That recovery phrase is not valid for this account. Check every word.";
      case CRYPTO_ERROR.workerCrashed:
        return "The secure worker stopped. Reload the page and unlock again.";
      case CRYPTO_ERROR.locked:
        return "Unlock your vault first.";
      case CRYPTO_ERROR.invalidKdfParams:
        return "The server sent unsafe key settings. Contact your administrator.";
      case CRYPTO_ERROR.cancelled:
        return "The vault was locked. Try again.";
      default:
        return fallback;
    }
  }
  return fallback;
}

export function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
