/** Base class. `code` survives structured cloning across the Web Worker boundary, `name` is explicit so minifiers can't mangle it. */
export class CryptoError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "CryptoError";
  }
}

/** AEAD authentication failed (wrong key, wrong AAD, tampered or malformed ciphertext). */
export class DecryptionError extends CryptoError {
  constructor(message = "Decryption failed", options?: ErrorOptions) {
    super("decryption_failed", message, options);
    this.name = "DecryptionError";
  }
}

/** The account key could not be unwrapped with the key derived from the typed password. */
export class WrongPasswordError extends CryptoError {
  constructor(message = "Wrong password", options?: ErrorOptions) {
    super("wrong_password", message, options);
    this.name = "WrongPasswordError";
  }
}

/** Not 24 valid BIP39 words, bad checksum, or a phrase that does not match the account. */
export class InvalidRecoveryPhraseError extends CryptoError {
  constructor(message = "Invalid recovery phrase", options?: ErrorOptions) {
    super("invalid_recovery_phrase", message, options);
    this.name = "InvalidRecoveryPhraseError";
  }
}

/** A sealed key decrypted fine but is not the key (type, id, key version) the record claimed. */
export class SealedKeyMismatchError extends CryptoError {
  constructor(message = "Sealed key does not match the expected record", options?: ErrorOptions) {
    super("sealed_key_mismatch", message, options);
    this.name = "SealedKeyMismatchError";
  }
}

/** Unknown envelope or payload format version. */
export class UnsupportedVersionError extends CryptoError {
  constructor(message = "Unsupported format version", options?: ErrorOptions) {
    super("unsupported_version", message, options);
    this.name = "UnsupportedVersionError";
  }
}

/** Item plaintext exceeds the maximum size. */
export class ItemTooLargeError extends CryptoError {
  constructor(message = "Item is too large", options?: ErrorOptions) {
    super("item_too_large", message, options);
    this.name = "ItemTooLargeError";
  }
}

/** KDF parameters are malformed or weaker than the enforced minimum (or absurdly large). */
export class InvalidKdfParamsError extends CryptoError {
  constructor(message = "Invalid KDF parameters", options?: ErrorOptions) {
    super("invalid_kdf_params", message, options);
    this.name = "InvalidKdfParamsError";
  }
}

/** Input is not canonical base64url. */
export class InvalidEncodingError extends CryptoError {
  constructor(message = "Invalid base64url encoding", options?: ErrorOptions) {
    super("invalid_encoding", message, options);
    this.name = "InvalidEncodingError";
  }
}
