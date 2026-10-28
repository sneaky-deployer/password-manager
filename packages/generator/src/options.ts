import type { CharsetToggles } from "./charsets.ts";
import { selectedCharsets } from "./charsets.ts";
import { GeneratorOptionsError } from "./errors.ts";

export const PASSWORD_LENGTH_MIN = 8;
export const PASSWORD_LENGTH_MAX = 128;
export const PASSPHRASE_WORDS_MIN = 3;
export const PASSPHRASE_WORDS_MAX = 12;

export type PasswordOptions = CharsetToggles & {
  /** 8-128. */
  length: number;
  /** Remove `0 O o 1 l I |` from every character set. */
  avoidAmbiguous: boolean;
};

export type PassphraseSeparator = "-" | " " | "." | "_" | "digit";
export const PASSPHRASE_SEPARATORS: readonly PassphraseSeparator[] = ["-", " ", ".", "_", "digit"];

export type PassphraseOptions = {
  /** 3-12. */
  words: number;
  /** `"digit"` puts a random digit between words. */
  separator: PassphraseSeparator;
  /** Capitalise the first letter of each word. */
  capitalize: boolean;
  /** Append a random digit to one random word. */
  includeNumber: boolean;
};

export const DEFAULT_PASSWORD_OPTIONS: Readonly<PasswordOptions> = Object.freeze({
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
});

export const DEFAULT_PASSPHRASE_OPTIONS: Readonly<PassphraseOptions> = Object.freeze({
  words: 5,
  separator: "-",
  capitalize: false,
  includeNumber: false,
});

/** Merges partial options over the defaults and validates them. */
export function resolvePasswordOptions(opts: Partial<PasswordOptions> = {}): PasswordOptions {
  const o: PasswordOptions = { ...DEFAULT_PASSWORD_OPTIONS, ...opts };
  if (
    !Number.isInteger(o.length) ||
    o.length < PASSWORD_LENGTH_MIN ||
    o.length > PASSWORD_LENGTH_MAX
  ) {
    throw new GeneratorOptionsError(
      `length must be an integer between ${PASSWORD_LENGTH_MIN} and ${PASSWORD_LENGTH_MAX}`,
    );
  }
  const setCount = selectedCharsets(o, o.avoidAmbiguous).length;
  if (setCount === 0) {
    throw new GeneratorOptionsError("select at least one character set");
  }
  if (o.length < setCount) {
    throw new GeneratorOptionsError(
      "length must be at least the number of selected character sets",
    );
  }
  return o;
}

/** Merges partial options over the defaults and validates them. */
export function resolvePassphraseOptions(opts: Partial<PassphraseOptions> = {}): PassphraseOptions {
  const o: PassphraseOptions = { ...DEFAULT_PASSPHRASE_OPTIONS, ...opts };
  if (
    !Number.isInteger(o.words) ||
    o.words < PASSPHRASE_WORDS_MIN ||
    o.words > PASSPHRASE_WORDS_MAX
  ) {
    throw new GeneratorOptionsError(
      `words must be an integer between ${PASSPHRASE_WORDS_MIN} and ${PASSPHRASE_WORDS_MAX}`,
    );
  }
  if (!PASSPHRASE_SEPARATORS.includes(o.separator)) {
    throw new GeneratorOptionsError('separator must be one of "-", " ", ".", "_" or "digit"');
  }
  return o;
}
