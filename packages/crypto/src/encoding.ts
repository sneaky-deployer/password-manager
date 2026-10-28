import { InvalidEncodingError } from "./errors.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  LOOKUP[ALPHABET.charCodeAt(i)] = i;
}

/** base64url without padding (RFC 4648 section 5). */
export function toBase64Url(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunks.push(
      ALPHABET.charAt((n >> 18) & 63) +
        ALPHABET.charAt((n >> 12) & 63) +
        ALPHABET.charAt((n >> 6) & 63) +
        ALPHABET.charAt(n & 63),
    );
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    chunks.push(ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63));
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    chunks.push(
      ALPHABET.charAt((n >> 18) & 63) +
        ALPHABET.charAt((n >> 12) & 63) +
        ALPHABET.charAt((n >> 6) & 63),
    );
  }
  return chunks.join("");
}

/** Strict decoder: URL-safe alphabet only, no padding, no whitespace, canonical trailing bits. */
export function fromBase64Url(text: string): Uint8Array {
  const len = text.length;
  if (len % 4 === 1) throw new InvalidEncodingError();
  const values = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? (LOOKUP[code] ?? -1) : -1;
    if (v < 0) throw new InvalidEncodingError();
    values[i] = v;
  }
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const n =
      ((values[i] ?? 0) << 18) |
      ((values[i + 1] ?? 0) << 12) |
      ((values[i + 2] ?? 0) << 6) |
      (values[i + 3] ?? 0);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = len - i;
  if (rest === 2) {
    const n = ((values[i] ?? 0) << 6) | (values[i + 1] ?? 0);
    if ((n & 15) !== 0) throw new InvalidEncodingError();
    out[o++] = n >> 4;
  } else if (rest === 3) {
    const n = ((values[i] ?? 0) << 12) | ((values[i + 1] ?? 0) << 6) | (values[i + 2] ?? 0);
    if ((n & 3) !== 0) throw new InvalidEncodingError();
    out[o++] = (n >> 10) & 255;
    out[o++] = (n >> 2) & 255;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Throws a `TypeError` on invalid UTF-8. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Length-independent-time byte comparison (returns false immediately only on length mismatch). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
