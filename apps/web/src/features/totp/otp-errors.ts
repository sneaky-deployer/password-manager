import type { OtpParseError } from "@pm/otp";

const MESSAGES: Record<OtpParseError, string> = {
  empty: "Enter the secret key or the otpauth:// link from the service.",
  invalid_uri:
    "This doesn't look like an authenticator link. It should start with otpauth://totp/ or be a plain secret key.",
  hotp_unsupported:
    "Counter-based (HOTP) codes aren't supported yet. Only time-based (TOTP) codes work.",
  invalid_secret:
    "The secret key isn't valid. It should only contain the letters A to Z and the digits 2 to 7.",
  invalid_digits: "The number of digits must be 6, 7 or 8.",
  invalid_period: "The refresh period must be between 1 and 300 seconds.",
  invalid_algorithm: "The algorithm must be SHA1, SHA256 or SHA512.",
  migration_unsupported:
    "This is a Google Authenticator export link, which can hold several accounts. Export or scan one account's own QR code instead.",
};

/** Plain-language message for each `parseOtpInput` error code. */
export function describeOtpError(error: OtpParseError): string {
  return MESSAGES[error];
}
