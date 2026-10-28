import { selectedCharsets } from "./charsets.ts";
import {
  type PassphraseOptions,
  type PasswordOptions,
  resolvePassphraseOptions,
  resolvePasswordOptions,
} from "./options.ts";
import { EFF_LARGE_WORDLIST } from "./wordlists/eff-large.ts";

export type Strength = "weak" | "fair" | "strong" | "very-strong";

/**
 * Password entropy in bits: `length * log2(poolSize)`, where `poolSize` is the number of distinct
 * characters in the union of the selected sets (after removing ambiguous characters). This is the
 * standard approximation; the "at least one per set" guarantee lowers the true value by a
 * fraction of a bit to a few bits.
 */
export function passwordEntropyBits(opts: Partial<PasswordOptions> = {}): number {
  const o = resolvePasswordOptions(opts);
  const poolSize = new Set(selectedCharsets(o, o.avoidAmbiguous).flat()).size;
  return o.length * Math.log2(poolSize);
}

/**
 * Passphrase entropy in bits:
 *   words * log2(7776)
 *   + (words - 1) * log2(10)       when the separator is "digit" (one random digit per gap)
 *   + log2(words) + log2(10)       when includeNumber is on (which word, and which digit)
 * Capitalisation and fixed separators are deterministic and add nothing.
 */
export function passphraseEntropyBits(opts: Partial<PassphraseOptions> = {}): number {
  const o = resolvePassphraseOptions(opts);
  let bits = o.words * Math.log2(EFF_LARGE_WORDLIST.length);
  if (o.separator === "digit") bits += (o.words - 1) * Math.log2(10);
  if (o.includeNumber) bits += Math.log2(o.words) + Math.log2(10);
  return bits;
}

/** Maps entropy to a label: < 50 weak, 50-79 fair, 80-99 strong, >= 100 very-strong. */
export function strengthFromBits(bits: number): Strength {
  if (bits < 50) return "weak";
  if (bits < 80) return "fair";
  if (bits < 100) return "strong";
  return "very-strong";
}
