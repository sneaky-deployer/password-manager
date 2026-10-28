// Drizzle schema for D1 (PLAN.md section 12, tombstones from section 13).
// Conventions: snake_case in SQL, camelCase in TS. IDs are UUID TEXT. Timestamps are INTEGER Unix
// milliseconds. Binary values are base64url TEXT. D1 enforces foreign keys, so ON DELETE CASCADE
// below does real work (deleting a user removes their sessions, vaults, memberships, ...).
// Schema changes go through `bun run db:generate`; never edit an applied migration.
import { isNotNull } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const USER_ROLES = ["admin", "user"] as const;
export const USER_STATUSES = ["active", "disabled"] as const;
export const INVITE_KINDS = ["new_account", "account_reset"] as const;
export const EMAIL_CODE_PURPOSES = ["recovery", "reset_account", "sensitive_action"] as const;
export const AUTH_CHALLENGE_KINDS = [
  "2fa",
  "recovery",
  "webauthn_register",
  "webauthn_auth",
] as const;
export const VAULT_MEMBER_ROLES = ["viewer", "editor", "manager", "owner"] as const;
export const ITEM_SHARE_ROLES = ["viewer", "editor"] as const;
export const SHARE_STATUSES = ["pending", "active"] as const;
export const DELETION_ENTITIES = ["vault", "item", "vault_member", "item_share"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type InviteKind = (typeof INVITE_KINDS)[number];
export type EmailCodePurpose = (typeof EMAIL_CODE_PURPOSES)[number];
export type AuthChallengeKind = (typeof AUTH_CHALLENGE_KINDS)[number];
export type VaultMemberRole = (typeof VAULT_MEMBER_ROLES)[number];
export type ItemShareRole = (typeof ITEM_SHARE_ROLES)[number];
export type ShareStatus = (typeof SHARE_STATUSES)[number];
export type DeletionEntity = (typeof DELETION_ENTITIES)[number];

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // client-generated
  email: text("email").notNull().unique(), // lowercased, trimmed
  emailVerifiedAt: integer("email_verified_at").notNull(), // set when the invite is accepted
  role: text("role", { enum: USER_ROLES }).notNull().default("user"),
  status: text("status", { enum: USER_STATUSES }).notNull().default("active"),
  // User id of the inviting admin; NULL for the bootstrap admin or after that admin is deleted.
  invitedBy: text("invited_by").references((): AnySQLiteColumn => users.id, {
    onDelete: "set null",
  }),
  lastLoginAt: integer("last_login_at"),
  kdfAlg: text("kdf_alg").notNull().default("argon2id13"),
  kdfMem: integer("kdf_mem").notNull(), // bytes
  kdfOps: integer("kdf_ops").notNull(),
  kdfSalt: text("kdf_salt").notNull(),
  authVerifier: text("auth_verifier").notNull(), // HMAC-SHA256 hex
  wrappedAkPw: text("wrapped_ak_pw").notNull(), // envelope
  wrappedAkRec: text("wrapped_ak_rec").notNull(), // envelope
  recoveryVerifier: text("recovery_verifier").notNull(), // HMAC-SHA256 hex
  publicKey: text("public_key").notNull(), // X25519
  encryptedPrivateKey: text("encrypted_private_key").notNull(), // envelope
  keyGeneration: integer("key_generation").notNull().default(1), // bumps on key rotation
  securityStamp: integer("security_stamp").notNull().default(1), // bump to invalidate sessions
  totpSecretEnc: text("totp_secret_enc"), // login 2FA, AES-GCM under SERVER_ENC_KEY
  totpLastStep: integer("totp_last_step"), // replay protection
  settings: text("settings").notNull().default("{}"), // JSON, non-sensitive
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(), // SHA-256 hex of the cookie token
    securityStamp: integer("security_stamp").notNull(), // users.security_stamp at creation
    userAgent: text("user_agent").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(), // created_at + 90 days
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const webauthnCredentials = sqliteTable(
  "webauthn_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports").notNull().default("[]"), // JSON array
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [
    uniqueIndex("webauthn_credentials_credential_id_uq").on(t.credentialId),
    index("webauthn_credentials_user_id_idx").on(t.userId),
  ],
);

export const backupCodes = sqliteTable(
  "backup_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(), // SHA-256 hex
    usedAt: integer("used_at"),
  },
  (t) => [index("backup_codes_user_id_idx").on(t.userId)],
);

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("user"),
    tokenHash: text("token_hash").notNull(), // SHA-256 hex of the emailed token
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: INVITE_KINDS }).notNull().default("new_account"),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("invites_token_hash_uq").on(t.tokenHash),
    index("invites_email_idx").on(t.email),
  ],
);

export const emailCodes = sqliteTable(
  "email_codes",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    purpose: text("purpose", { enum: EMAIL_CODE_PURPOSES }).notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull(), // not in PLAN.md 12; lets routes enforce a resend cooldown
  },
  (t) => [index("email_codes_email_purpose_idx").on(t.email, t.purpose)],
);

export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: AUTH_CHALLENGE_KINDS }).notNull(),
    tokenHash: text("token_hash").notNull(),
    payload: text("payload").notNull().default("{}"), // JSON
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("auth_challenges_token_hash_uq").on(t.tokenHash),
    index("auth_challenges_user_id_idx").on(t.userId),
  ],
);

export const vaults = sqliteTable(
  "vaults",
  {
    id: text("id").primaryKey(), // client-generated
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyVersion: integer("key_version").notNull().default(1),
    encryptedMeta: text("encrypted_meta").notNull(), // name/icon/colour under VK
    rotationPending: integer("rotation_pending", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("vaults_owner_id_idx").on(t.ownerId)],
);

export const vaultMembers = sqliteTable(
  "vault_members",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: VAULT_MEMBER_ROLES }).notNull(),
    keyVersion: integer("key_version").notNull(),
    sealedKey: text("sealed_key").notNull(), // VK sealed to the member's public key
    status: text("status", { enum: SHARE_STATUSES }).notNull().default("active"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("vault_members_vault_user_uq").on(t.vaultId, t.userId),
    index("vault_members_user_id_idx").on(t.userId),
  ],
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(), // client-generated
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    itemKeyVersion: integer("item_key_version").notNull(),
    wrappedKey: text("wrapped_key").notNull(), // IK under VK
    vaultKeyVersion: integer("vault_key_version").notNull(), // which VK wrapped it
    encryptedData: text("encrypted_data").notNull(), // content under IK, max ~90 KB encoded
    revision: integer("revision").notNull().default(1), // optimistic concurrency
    createdBy: text("created_by").notNull(), // user ids; no FK so shared items outlive their author
    updatedBy: text("updated_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    trashedAt: integer("trashed_at"), // soft delete, purged after 30 days
  },
  (t) => [
    // Also serves plain `vault_id = ?` lookups, so there is no separate vault_id index.
    index("items_vault_updated_idx").on(t.vaultId, t.updatedAt),
    // Partial: only trashed rows, so the daily purge does not scan every item.
    index("items_trashed_at_idx").on(t.trashedAt).where(isNotNull(t.trashedAt)),
  ],
);

export const itemShares = sqliteTable(
  "item_shares",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ITEM_SHARE_ROLES }).notNull(),
    keyVersion: integer("key_version").notNull(),
    sealedKey: text("sealed_key").notNull(), // IK sealed to the recipient's public key
    status: text("status", { enum: SHARE_STATUSES }).notNull().default("pending"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("item_shares_item_user_uq").on(t.itemId, t.userId),
    index("item_shares_user_id_idx").on(t.userId),
  ],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    // e.g. `login:email:<sha256 of email>`, `login:ip:<ip>`. Never store raw emails here.
    key: text("key").primaryKey(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [index("rate_limits_window_start_idx").on(t.windowStart)],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    event: text("event").notNull(), // login, password_changed, recovery_used, share_created, ...
    meta: text("meta").notNull().default("{}"), // JSON, never secrets
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("audit_events_user_created_idx").on(t.userId, t.createdAt),
    index("audit_events_created_at_idx").on(t.createdAt), // daily purge
  ],
);

/**
 * Tombstones for incremental sync (PLAN.md section 13). `vault_id` tells vault members to drop the
 * entity; `user_id` is set when it only matters to one user (e.g. their own membership or share).
 * No foreign keys: the referenced rows are gone by definition. Purged after 90 days.
 */
export const deletions = sqliteTable(
  "deletions",
  {
    id: text("id").primaryKey(),
    entity: text("entity", { enum: DELETION_ENTITIES }).notNull(),
    entityId: text("entity_id").notNull(),
    vaultId: text("vault_id"),
    userId: text("user_id"),
    deletedAt: integer("deleted_at").notNull(),
  },
  (t) => [index("deletions_deleted_at_idx").on(t.deletedAt)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert;
export type BackupCode = typeof backupCodes.$inferSelect;
export type NewBackupCode = typeof backupCodes.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type EmailCode = typeof emailCodes.$inferSelect;
export type NewEmailCode = typeof emailCodes.$inferInsert;
export type AuthChallenge = typeof authChallenges.$inferSelect;
export type NewAuthChallenge = typeof authChallenges.$inferInsert;
export type Vault = typeof vaults.$inferSelect;
export type NewVault = typeof vaults.$inferInsert;
export type VaultMember = typeof vaultMembers.$inferSelect;
export type NewVaultMember = typeof vaultMembers.$inferInsert;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemShare = typeof itemShares.$inferSelect;
export type NewItemShare = typeof itemShares.$inferInsert;
export type RateLimit = typeof rateLimits.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type Deletion = typeof deletions.$inferSelect;
export type NewDeletion = typeof deletions.$inferInsert;
