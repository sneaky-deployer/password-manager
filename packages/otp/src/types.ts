export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";
export type OtpDigits = 6 | 7 | 8;

export type OtpConfig = {
  /** Base32 (RFC 4648), uppercase, no padding, no spaces. */
  secret: string;
  algorithm: OtpAlgorithm;
  digits: OtpDigits;
  /** Seconds, 1..300. */
  period: number;
  issuer?: string;
  /** Account name (without the issuer prefix). */
  label?: string;
};

export type OtpParseError =
  | "empty"
  | "invalid_uri"
  | "hotp_unsupported"
  | "invalid_secret"
  | "invalid_digits"
  | "invalid_period"
  | "invalid_algorithm"
  | "migration_unsupported";

export type OtpParseResult = { ok: true; config: OtpConfig } | { ok: false; error: OtpParseError };
