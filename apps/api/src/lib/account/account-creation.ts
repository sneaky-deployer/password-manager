// Turns the client's account creation material (`accountCreationSchema`) into the rows of a new
// account: user, default vault, owner membership, first session and an audit entry. Shared by
// `accept-invite` and `reset-account` so both create accounts identically.
import { type AccountCreation, DEFAULT_USER_SETTINGS } from "@pm/shared";
import type { Db } from "../../db/client.ts";
import {
  type NewUser,
  type User,
  type UserRole,
  users,
  vaultMembers,
  vaults,
} from "../../db/schema.ts";
import type { Config } from "../../env.ts";
import { auditStatement } from "../audit.ts";
import { newId } from "../crypto.ts";
import { type PreparedSession, prepareSession } from "../sessions.ts";
import type { BatchStatement } from "./account-deletion.ts";
import { computeVerifier } from "./verifiers.ts";

export interface NewAccountOptions {
  email: string;
  role: UserRole;
  invitedBy: string | null;
  userAgent: string | null;
  auditEvent: string;
  auditMeta?: Record<string, string | number | boolean | null>;
  now?: number;
}

export interface NewAccount {
  user: User;
  session: PreparedSession;
  /** Inserts for the user, vault, owner membership, session and audit row, in FK order. */
  statements: BatchStatement[];
}

export async function buildNewAccount(
  db: Db,
  config: Config,
  material: AccountCreation,
  options: NewAccountOptions,
): Promise<NewAccount> {
  const now = options.now ?? Date.now();
  const { user: u, vault: v } = material;
  const [authVerifier, recoveryVerifier] = await Promise.all([
    computeVerifier(config, u.authKey),
    computeVerifier(config, u.recoveryAuthKey),
  ]);
  const row: NewUser = {
    id: u.id,
    email: options.email,
    emailVerifiedAt: now, // opening the emailed link (or code) proves inbox access
    role: options.role,
    status: "active",
    invitedBy: options.invitedBy,
    lastLoginAt: now,
    kdfAlg: u.kdf.alg,
    kdfMem: u.kdf.mem,
    kdfOps: u.kdf.ops,
    kdfSalt: u.salt,
    authVerifier,
    wrappedAkPw: u.wrappedAkPw,
    wrappedAkRec: u.wrappedAkRec,
    recoveryVerifier,
    publicKey: u.publicKey,
    encryptedPrivateKey: u.encryptedPrivateKey,
    keyGeneration: 1,
    securityStamp: 1,
    totpSecretEnc: null,
    totpLastStep: null,
    settings: JSON.stringify(DEFAULT_USER_SETTINGS),
    createdAt: now,
    updatedAt: now,
  };
  const session = await prepareSession(
    db,
    config,
    { id: u.id, securityStamp: 1 },
    options.userAgent,
    now,
  );
  const statements: BatchStatement[] = [
    db.insert(users).values(row),
    db.insert(vaults).values({
      id: v.id,
      ownerId: u.id,
      keyVersion: 1,
      encryptedMeta: v.encryptedMeta,
      rotationPending: false,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vaultMembers).values({
      id: newId(),
      vaultId: v.id,
      userId: u.id,
      role: "owner",
      keyVersion: 1,
      sealedKey: v.sealedKey,
      status: "active",
      invitedBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    session.insert,
    auditStatement(db, u.id, options.auditEvent, options.auditMeta ?? {}, now),
  ];
  return { user: row as User, session, statements };
}
