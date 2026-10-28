import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { toBase64Url } from "./encoding.ts";
import { InvalidRecoveryPhraseError } from "./errors.ts";
import { deriveSubkey } from "./kdf.ts";
import { memzero } from "./memzero.ts";
import { sodiumReady } from "./sodium.ts";

export const RECOVERY_KDF_CONTEXT = "PMRECV01";
export const RECOVERY_AUTH_KEY_SUBKEY_ID = 1;
export const RECOVERY_WRAP_KEY_SUBKEY_ID = 2;
export const RECOVERY_ENTROPY_BYTES = 32;
export const RECOVERY_WORD_COUNT = 24;

export interface RecoveryKeys {
  /** Proves possession of the phrase to the server. */
  recoveryAuthKey: Uint8Array;
  /** Encrypts the second copy of the account key. */
  recoveryWrapKey: Uint8Array;
}

/** Lowercase, trim and collapse any whitespace to single spaces. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

/** 32 bytes -> 24-word BIP39 English mnemonic. */
export function entropyToRecoveryPhrase(entropy: Uint8Array): string {
  if (entropy.length !== RECOVERY_ENTROPY_BYTES) {
    throw new TypeError(`Recovery entropy must be ${RECOVERY_ENTROPY_BYTES} bytes`);
  }
  return entropyToMnemonic(entropy, wordlist);
}

/** Fresh random recovery phrase. */
export async function generateRecoveryPhrase(): Promise<string> {
  const sodium = await sodiumReady();
  const entropy = sodium.randombytes_buf(RECOVERY_ENTROPY_BYTES);
  try {
    return entropyToRecoveryPhrase(entropy);
  } finally {
    memzero(entropy);
  }
}

/** Normalise, check word count and BIP39 checksum, return the 32-byte entropy. */
export function parseRecoveryPhrase(phrase: string): Uint8Array {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (normalized.split(" ").length !== RECOVERY_WORD_COUNT) {
    throw new InvalidRecoveryPhraseError(`Recovery phrase must have ${RECOVERY_WORD_COUNT} words`);
  }
  try {
    const entropy = mnemonicToEntropy(normalized, wordlist);
    if (entropy.length !== RECOVERY_ENTROPY_BYTES) throw new Error("unexpected entropy length");
    return entropy;
  } catch (error) {
    throw new InvalidRecoveryPhraseError("Invalid recovery phrase", { cause: error });
  }
}

/** PMRECV01 subkeys 1 (recoveryAuthKey) and 2 (recoveryWrapKey) from the 32-byte entropy. */
export async function deriveRecoveryKeys(entropy: Uint8Array): Promise<RecoveryKeys> {
  if (entropy.length !== RECOVERY_ENTROPY_BYTES) {
    throw new TypeError(`Recovery entropy must be ${RECOVERY_ENTROPY_BYTES} bytes`);
  }
  return {
    recoveryAuthKey: await deriveSubkey(entropy, RECOVERY_AUTH_KEY_SUBKEY_ID, RECOVERY_KDF_CONTEXT),
    recoveryWrapKey: await deriveSubkey(entropy, RECOVERY_WRAP_KEY_SUBKEY_ID, RECOVERY_KDF_CONTEXT),
  };
}

export async function deriveRecoveryKeysFromPhrase(phrase: string): Promise<RecoveryKeys> {
  const entropy = parseRecoveryPhrase(phrase);
  try {
    return await deriveRecoveryKeys(entropy);
  } finally {
    memzero(entropy);
  }
}

/** base64url recoveryAuthKey for `POST /auth/recovery/start`. */
export async function recoveryAuthKeyFromPhrase(phrase: string): Promise<string> {
  const keys = await deriveRecoveryKeysFromPhrase(phrase);
  try {
    return toBase64Url(keys.recoveryAuthKey);
  } finally {
    memzero(keys.recoveryAuthKey);
    memzero(keys.recoveryWrapKey);
  }
}
