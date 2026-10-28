import type { InviteWire, KeyBundle, MeSummary } from "@pm/shared";

/** Valid-shaped base64url strings (the schemas only check shape and length). */
export const b64 = (length: number, fill = "A") => fill.repeat(length);
export const KEY32 = b64(43);
export const SALT16 = b64(22);
export const ENVELOPE = b64(60);
export const TOKEN32 = b64(43, "T");

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_ID = "22222222-2222-4222-8222-222222222222";
export const VAULT_ID = "33333333-3333-4333-8333-333333333333";

export function makeUser(overrides: Partial<MeSummary> = {}): MeSummary {
  return {
    id: USER_ID,
    email: "alice@example.com",
    role: "user",
    twoFactor: { totp: false, webauthn: 0 },
    settings: { autoLockMinutes: 15, theme: "system" },
    ...overrides,
  };
}

export function makeKeyBundle(overrides: Partial<KeyBundle> = {}): KeyBundle {
  return {
    userId: USER_ID,
    kdf: { alg: "argon2id13", mem: 64 * 1024 * 1024, ops: 3 },
    salt: SALT16,
    wrappedAkPw: ENVELOPE,
    publicKey: KEY32,
    encryptedPrivateKey: ENVELOPE,
    keyGeneration: 1,
    ...overrides,
  };
}

export function makeInvite(overrides: Partial<InviteWire> = {}): InviteWire {
  return {
    id: OTHER_ID,
    email: "bob@example.com",
    role: "user",
    kind: "new_account",
    status: "pending",
    invitedBy: USER_ID,
    expiresAt: Date.now() + 3 * 86_400_000,
    acceptedAt: null,
    revokedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

export const WORDS_24 = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
];
export const PHRASE_24 = WORDS_24.join(" ");
