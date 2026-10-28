import type { OtpAlgorithm, OtpConfig, OtpDigits, OtpParseError, OtpParseResult } from "./types.ts";

export const DEFAULT_ALGORITHM: OtpAlgorithm = "SHA1";
export const DEFAULT_DIGITS: OtpDigits = 6;
export const DEFAULT_PERIOD = 30;
export const MIN_PERIOD = 1;
export const MAX_PERIOD = 300;
/** Secrets shorter than this (128 bits, the RFC 4226 recommendation) are "weak". */
export const WEAK_SECRET_BYTES = 16;

const BASE32_RE = /^[A-Z2-7]+$/;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const ALGORITHMS: readonly OtpAlgorithm[] = ["SHA1", "SHA256", "SHA512"];

function fail(error: OtpParseError): OtpParseResult {
  return { ok: false, error };
}

/**
 * Upper-cases and strips spaces, hyphens and trailing `=` padding. Returns null when the result is
 * not valid Base32 or decodes to less than one byte.
 */
export function normalizeSecret(raw: string): string | null {
  const s = raw
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .replace(/=+$/, "");
  if (!BASE32_RE.test(s) || base32ByteLength(s) < 1) return null;
  return s;
}

/** Number of whole bytes a normalised Base32 string decodes to (leftover bits are dropped). */
export function base32ByteLength(secret: string): number {
  return Math.floor((secret.length * 5) / 8);
}

/** True when the secret is shorter than 128 bits; the UI should warn but still accept it. */
export function isWeakSecret(config: Pick<OtpConfig, "secret">): boolean {
  return base32ByteLength(config.secret) < WEAK_SECRET_BYTES;
}

function parseIntStrict(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * Parses a pasted/scanned TOTP source: an `otpauth://totp/...` URI or a bare Base32 secret.
 * Never throws.
 */
export function parseOtpInput(input: string): OtpParseResult {
  const text = input.trim();
  if (text === "") return fail("empty");

  const scheme = SCHEME_RE.exec(text);
  if (!scheme) {
    const secret = normalizeSecret(text);
    if (secret === null) return fail("invalid_secret");
    return {
      ok: true,
      config: {
        secret,
        algorithm: DEFAULT_ALGORITHM,
        digits: DEFAULT_DIGITS,
        period: DEFAULT_PERIOD,
      },
    };
  }

  const schemeName = (scheme[1] ?? "").toLowerCase();
  if (schemeName === "otpauth-migration") return fail("migration_unsupported");
  if (schemeName !== "otpauth") return fail("invalid_uri");
  return parseOtpauthUri(text.slice(scheme[0].length));
}

function parseOtpauthUri(rest: string): OtpParseResult {
  // rest = "<type>/<label>?<query>" (fragment ignored)
  const noFragment = rest.split("#", 1)[0] ?? "";
  const qIndex = noFragment.indexOf("?");
  const pathPart = qIndex === -1 ? noFragment : noFragment.slice(0, qIndex);
  const query = qIndex === -1 ? "" : noFragment.slice(qIndex + 1);

  const slash = pathPart.indexOf("/");
  const type = (slash === -1 ? pathPart : pathPart.slice(0, slash)).toLowerCase();
  const rawLabel = slash === -1 ? "" : pathPart.slice(slash + 1);

  if (type === "hotp") return fail("hotp_unsupported");
  if (type !== "totp") return fail("invalid_uri");

  // Split "Issuer:account" on the first literal colon (else the first %3A) *before* decoding, so
  // colons inside an encoded issuer or account survive.
  let rawPrefix: string | null = null;
  let rawAccount = rawLabel;
  const sep = rawLabel.includes(":") ? rawLabel.indexOf(":") : rawLabel.search(/%3a/i);
  if (sep !== -1) {
    rawPrefix = rawLabel.slice(0, sep);
    rawAccount = rawLabel.slice(rawLabel.startsWith(":", sep) ? sep + 1 : sep + 3);
  }
  let prefix: string | null;
  let account: string;
  try {
    prefix = rawPrefix === null ? null : decodeURIComponent(rawPrefix).trim();
    account = decodeURIComponent(rawAccount).trim();
  } catch {
    return fail("invalid_uri");
  }

  const params = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(query)) {
    const k = key.toLowerCase();
    if (!params.has(k)) params.set(k, value);
  }

  const secretParam = params.get("secret");
  if (secretParam === undefined) return fail("invalid_secret");
  const secret = normalizeSecret(secretParam);
  if (secret === null) return fail("invalid_secret");

  const algorithmParam = params.get("algorithm");
  let algorithm: OtpAlgorithm = DEFAULT_ALGORITHM;
  if (algorithmParam !== undefined) {
    const upper = algorithmParam.trim().toUpperCase();
    const found = ALGORITHMS.find((a) => a === upper);
    if (!found) return fail("invalid_algorithm");
    algorithm = found;
  }

  const digitsParam = params.get("digits");
  let digits: OtpDigits = DEFAULT_DIGITS;
  if (digitsParam !== undefined) {
    const n = parseIntStrict(digitsParam);
    if (n !== 6 && n !== 7 && n !== 8) return fail("invalid_digits");
    digits = n;
  }

  const periodParam = params.get("period");
  let period = DEFAULT_PERIOD;
  if (periodParam !== undefined) {
    const n = parseIntStrict(periodParam);
    if (n === null || n < MIN_PERIOD || n > MAX_PERIOD) return fail("invalid_period");
    period = n;
  }

  // Issuer: the `issuer` parameter wins; otherwise the "Issuer:" label prefix. A prefix that
  // differs from the issuer param is not an issuer, so it stays part of the label.
  let issuer = params.get("issuer")?.trim() || undefined;
  if (prefix !== null) {
    if (issuer === undefined) issuer = prefix || undefined;
    else if (prefix.toLowerCase() !== issuer.toLowerCase()) account = `${prefix}:${account}`;
  }

  const config: OtpConfig = { secret, algorithm, digits, period };
  if (issuer) config.issuer = issuer;
  if (account) config.label = account;
  return { ok: true, config };
}

/** Normalised `otpauth://totp/...` URI; always includes algorithm, digits and period. */
export function toOtpauthUri(config: OtpConfig): string {
  const { issuer, label } = config;
  let path = "";
  // The separator is always a literal ":"; colons inside issuer/label are percent-encoded.
  if (issuer) path = `${encodeURIComponent(issuer)}:${label ? encodeURIComponent(label) : ""}`;
  else if (label) path = `${label.includes(":") ? ":" : ""}${encodeURIComponent(label)}`;

  const params = [`secret=${config.secret}`];
  if (issuer) params.push(`issuer=${encodeURIComponent(issuer)}`);
  params.push(
    `algorithm=${config.algorithm}`,
    `digits=${config.digits}`,
    `period=${config.period}`,
  );
  return `otpauth://totp/${path}?${params.join("&")}`;
}
