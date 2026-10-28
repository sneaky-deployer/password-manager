/** Test helpers: random bytes encoded as base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function rand(n: number): string {
  const bytes = new Uint8Array(n);
  for (let offset = 0; offset < n; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, n)));
  }
  return b64url(bytes);
}

export const uuid = (): string => crypto.randomUUID();

/** A syntactically valid envelope around `plaintextBytes` bytes. */
export const envelope = (plaintextBytes = 32): string => rand(1 + 24 + plaintextBytes + 16);

/** A syntactically valid sealed box around a payload of `payloadBytes` bytes. */
export const sealedBox = (payloadBytes = 130): string => rand(32 + 16 + payloadBytes);

export const kdf = { alg: "argon2id13", mem: 67108864, ops: 3 } as const;

export function accountCreation() {
  return {
    user: {
      id: uuid(),
      kdf,
      salt: rand(16),
      authKey: rand(32),
      wrappedAkPw: envelope(),
      wrappedAkRec: envelope(),
      recoveryAuthKey: rand(32),
      publicKey: rand(32),
      encryptedPrivateKey: envelope(),
    },
    vault: {
      id: uuid(),
      keyVersion: 1,
      encryptedMeta: envelope(40),
      sealedKey: sealedBox(),
    },
  };
}

export function meSummary() {
  return {
    id: uuid(),
    email: "owner@example.com",
    role: "admin",
    twoFactor: { totp: false, webauthn: 0 },
    settings: { autoLockMinutes: 15, theme: "system" },
  };
}

export function keyBundle() {
  return {
    userId: uuid(),
    kdf,
    salt: rand(16),
    wrappedAkPw: envelope(),
    publicKey: rand(32),
    encryptedPrivateKey: envelope(),
    keyGeneration: 1,
  };
}

export function itemWire() {
  return {
    id: uuid(),
    vaultId: uuid(),
    itemKeyVersion: 1,
    wrappedKey: envelope(),
    vaultKeyVersion: 1,
    encryptedData: envelope(500),
    revision: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    trashedAt: null,
    createdBy: uuid(),
    updatedBy: uuid(),
  };
}
