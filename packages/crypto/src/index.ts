export const PACKAGE_NAME = "@pm/crypto";

export { aad } from "./aad.ts";
export {
  type AccountKeys,
  buildPasswordChange,
  buildRecoveryKit,
  type CreatedAccount,
  createAccount,
  deriveAuthKeyForLogin,
  deriveLoginKeys,
  unlockAccount,
  unlockAccountWithWrapKey,
  unwrapAccountKeyWithRecovery,
} from "./account.ts";
export {
  constantTimeEqual,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "./encoding.ts";
export { ENVELOPE_VERSION, NONCE_BYTES, open, seal, TAG_BYTES } from "./envelope.ts";
export * from "./errors.ts";
export {
  buildEncryptedItem,
  createEncryptedItem,
  decryptItem,
  type EncryptedItem,
  encryptItem,
  MAX_ITEM_PLAINTEXT_BYTES,
  reencryptItem,
  type StoredItemCiphertext,
  unwrapItemKey,
  wrapItemKey,
} from "./item.ts";
export {
  DEFAULT_KDF,
  derivePasswordKeys,
  type KdfParams,
  kdfNeedsUpgrade,
  MAX_KDF_MEM,
  MAX_KDF_OPS,
  MIN_KDF_MEM,
  MIN_KDF_OPS,
  type PasswordKeys,
  SALT_BYTES,
  validateKdfParams,
} from "./kdf.ts";
export { generateKey, KEY_BYTES } from "./keys.ts";
export { memzero, wipe } from "./memzero.ts";
export {
  deriveRecoveryKeys,
  deriveRecoveryKeysFromPhrase,
  entropyToRecoveryPhrase,
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  parseRecoveryPhrase,
  RECOVERY_WORD_COUNT,
  type RecoveryKeys,
  recoveryAuthKeyFromPhrase,
} from "./recovery.ts";
export {
  type RotatedVault,
  type RotateVaultKeyParams,
  rotateVaultKey,
} from "./rotation.ts";
export {
  openSealedKey,
  type SealedKeyPayload,
  type SealedKeyReference,
  type SealedKeyType,
  sealKey,
} from "./sealed.ts";
export { sodiumReady } from "./sodium.ts";
export type {
  AccountCreation,
  EncryptedItemWire,
  KeyBundle,
  PasswordChangeMaterial,
  RecoveryKitReplace,
  VaultMeta,
} from "./types.ts";
export { decryptVaultMeta, encryptVaultMeta } from "./vault.ts";
