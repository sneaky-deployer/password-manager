// New password material (PLAN.md 10.4, 10.5): password change, change from an unlocked device,
// forgot-password recovery and KDF upgrade all replace salt, KDF parameters, verifier and the
// password-wrapped account key. Nothing else about the account changes, and no item is touched.
import type { PasswordChange } from "@pm/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { type User, users } from "../../db/schema.ts";
import type { Config } from "../../env.ts";
import { computeVerifier } from "./verifiers.ts";

export interface PasswordUpdate {
  /** Un-awaited UPDATE for `db.batch`. */
  statement: ReturnType<ReturnType<ReturnType<Db["update"]>["set"]>["where"]>;
  /** The user as it will look after the update (for the response and the new session's stamp). */
  updated: User;
}

/**
 * `bumpStamp: true` also increments `security_stamp` (every session stops working: password
 * change and recovery). Stamp the replacement session with `updated.securityStamp`.
 */
export async function buildPasswordUpdate(
  db: Db,
  config: Config,
  user: User,
  change: PasswordChange,
  options: { bumpStamp: boolean; now?: number; lastLogin?: boolean },
): Promise<PasswordUpdate> {
  const now = options.now ?? Date.now();
  const authVerifier = await computeVerifier(config, change.newAuthKey);
  const values = {
    kdfAlg: change.newKdf.alg,
    kdfMem: change.newKdf.mem,
    kdfOps: change.newKdf.ops,
    kdfSalt: change.newSalt,
    authVerifier,
    wrappedAkPw: change.newWrappedAk,
    updatedAt: now,
  };
  const statement = db
    .update(users)
    .set({
      ...values,
      ...(options.bumpStamp ? { securityStamp: sql`${users.securityStamp} + 1` } : {}),
      ...(options.lastLogin ? { lastLoginAt: now } : {}),
    })
    .where(eq(users.id, user.id));
  return {
    statement,
    updated: {
      ...user,
      ...values,
      securityStamp: options.bumpStamp ? user.securityStamp + 1 : user.securityStamp,
      lastLoginAt: options.lastLogin ? now : user.lastLoginAt,
    },
  };
}
