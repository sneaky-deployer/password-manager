/** Limits, defaults and enumerations shared by the API and the web app (PLAN.md sections 4, 10, 11, 19). */

// --- KDF (PLAN.md 9.1, 19) ---------------------------------------------------------------------

/** Argon2id parameters used for new accounts. `mem` is in bytes. */
export const KDF_DEFAULTS = {
  alg: "argon2id13",
  mem: 64 * 1024 * 1024,
  ops: 3,
} as const;

/** Lowest parameters the server accepts. Anything weaker is rejected at the API boundary. */
export const KDF_MINIMUMS = {
  mem: 16 * 1024 * 1024,
  ops: 2,
} as const;

/** Highest parameters the server accepts (sanity cap so a bad client cannot lock a user out). */
export const KDF_MAXIMUMS = {
  mem: 1024 * 1024 * 1024,
  ops: 16,
} as const;

// --- Sizes -------------------------------------------------------------------------------------

/** Maximum serialized (UTF-8 JSON) item content before encryption: 64 KiB. */
export const MAX_ITEM_PLAINTEXT_BYTES = 65536;

/** Envelope overhead: 1 byte version + 24 byte nonce + 16 byte Poly1305 tag. */
export const ENVELOPE_OVERHEAD_BYTES = 41;

/** Maximum base64url length of any envelope (96 KiB; item content at 64 KiB needs about 87.4k). */
export const MAX_ENCRYPTED_DATA_CHARS = 96 * 1024;

/** Maximum base64url length of small envelopes: wrapped keys, wrapped AK, encrypted private key. */
export const MAX_SMALL_ENVELOPE_CHARS = 1024;

/** Maximum base64url length of encrypted vault metadata. */
export const MAX_META_ENVELOPE_CHARS = 8192;

/** Maximum items per vault rotation chunk (PLAN.md 11.4). */
export const MAX_ROTATION_CHUNK_ITEMS = 100;

// --- Lifetimes and limits ----------------------------------------------------------------------

export const INVITE_TTL_HOURS_DEFAULT = 72;
export const TRASH_RETENTION_DAYS = 30;
export const SESSION_IDLE_DAYS = 30;
export const SESSION_ABSOLUTE_DAYS = 90;
export const EMAIL_CODE_TTL_MINUTES = 15;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Digits in an emailed code. */
export const EMAIL_CODE_LENGTH = 6;
export const TWO_FACTOR_CHALLENGE_TTL_MINUTES = 5;
export const RECOVERY_TOKEN_TTL_MINUTES = 10;
export const BACKUP_CODE_COUNT = 10;
export const AUDIT_RETENTION_DAYS = 90;
export const DELETION_TOMBSTONE_RETENTION_DAYS = 90;

export const AUTO_LOCK_MINUTES_DEFAULT = 15;
export const AUTO_LOCK_MINUTES_MIN = 1;
export const AUTO_LOCK_MINUTES_MAX = 24 * 60;

export const SESSION_COOKIE_NAME = "__Host-pm_session";

// --- Enumerations ------------------------------------------------------------------------------

/** Application roles (PLAN.md 10). */
export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Vault roles in increasing order of power (PLAN.md 11.1). */
export const VAULT_ROLES = ["viewer", "editor", "manager", "owner"] as const;
export type VaultRole = (typeof VAULT_ROLES)[number];

/** Roles that can be granted when inviting a member. Ownership is never granted by invite. */
export const VAULT_INVITE_ROLES = ["viewer", "editor", "manager"] as const;
export type VaultInviteRole = (typeof VAULT_INVITE_ROLES)[number];

export const ITEM_SHARE_ROLES = ["viewer", "editor"] as const;
export type ItemShareRole = (typeof ITEM_SHARE_ROLES)[number];

/** Membership and item share lifecycle. */
export const SHARE_STATUSES = ["pending", "active"] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/** Why an invite exists: first account, or an admin-initiated account reset (PLAN.md 10.5 D). */
export const INVITE_KINDS = ["new_account", "account_reset"] as const;
export type InviteKind = (typeof INVITE_KINDS)[number];

/** Derived invite state shown in the admin list. */
export const INVITE_STATUSES = ["pending", "accepted", "expired", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** Purposes of an emailed code (PLAN.md 12 `email_codes`). */
export const EMAIL_CODE_PURPOSES = ["recovery", "reset_account", "sensitive_action"] as const;
export type EmailCodePurpose = (typeof EMAIL_CODE_PURPOSES)[number];

/** Purposes accepted by the unauthenticated `/auth/email/start`. */
export const PUBLIC_EMAIL_CODE_PURPOSES = ["recovery", "reset_account"] as const;
export type PublicEmailCodePurpose = (typeof PUBLIC_EMAIL_CODE_PURPOSES)[number];

/** Second factors for signing in (PLAN.md 10.6). */
export const TWO_FACTOR_METHODS = ["totp", "webauthn", "backup_code"] as const;
export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Entities that can appear as tombstones in a sync response. */
export const DELETION_ENTITIES = ["vault", "item", "vault_member", "item_share"] as const;
export type DeletionEntity = (typeof DELETION_ENTITIES)[number];

/** Item content types (PLAN.md 14.1). */
export const ITEM_TYPES = ["login", "note"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
