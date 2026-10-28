import type { KdfParams } from "./kdf.ts";

/** Wire shapes shared with the API. All binary values are base64url strings without padding. */

export interface AccountCreation {
  user: {
    id: string;
    kdf: KdfParams;
    salt: string;
    authKey: string;
    wrappedAkPw: string;
    wrappedAkRec: string;
    recoveryAuthKey: string;
    publicKey: string;
    encryptedPrivateKey: string;
  };
  vault: {
    id: string;
    keyVersion: 1;
    encryptedMeta: string;
    sealedKey: string;
  };
}

export interface KeyBundle {
  userId: string;
  kdf: KdfParams;
  salt: string;
  wrappedAkPw: string;
  publicKey: string;
  encryptedPrivateKey: string;
  keyGeneration: number;
}

export interface PasswordChangeMaterial {
  newSalt: string;
  newKdf: KdfParams;
  newAuthKey: string;
  newWrappedAk: string;
}

export interface RecoveryKitReplace {
  wrappedAkRec: string;
  recoveryAuthKey: string;
}

export interface VaultMeta {
  name: string;
  icon?: string;
  color?: string;
}

/** Create-item request body. */
export interface EncryptedItemWire {
  id: string;
  vaultId: string;
  itemKeyVersion: number;
  wrappedKey: string;
  vaultKeyVersion: number;
  encryptedData: string;
}
