export const PACKAGE_NAME = "@pm/generator";

export { AMBIGUOUS, DIGITS, LOWERCASE, SYMBOLS, UPPERCASE } from "./charsets.ts";
export {
  passphraseEntropyBits,
  passwordEntropyBits,
  type Strength,
  strengthFromBits,
} from "./entropy.ts";
export { GeneratorOptionsError } from "./errors.ts";
export {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  PASSPHRASE_SEPARATORS,
  PASSPHRASE_WORDS_MAX,
  PASSPHRASE_WORDS_MIN,
  PASSWORD_LENGTH_MAX,
  PASSWORD_LENGTH_MIN,
  type PassphraseOptions,
  type PassphraseSeparator,
  type PasswordOptions,
} from "./options.ts";
export { generatePassphrase } from "./passphrase.ts";
export { generatePassword } from "./password.ts";
export { randomInt, shuffle, type Uint32Source } from "./random.ts";
export { EFF_LARGE_WORDLIST } from "./wordlists/eff-large.ts";
