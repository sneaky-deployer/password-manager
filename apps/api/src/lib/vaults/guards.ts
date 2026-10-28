// Write guards for vault state: key version and rotation. Routes check them against the rows they
// just read (for clear errors) AND repeat them inside the write statement (`exists(...)`) so a
// rotation finishing between the read and the write cannot slip stale ciphertext into the vault.

import type { SQL } from "drizzle-orm";
import { and, eq, exists, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../../db/client.ts";
import { type Vault, vaults } from "../../db/schema.ts";
import { keyVersionMismatch, notFound, rotationPending } from "./errors.ts";

/**
 * Item writes (create, update, move) are blocked while a rotation is pending: the rotation
 * snapshot would go stale and anything written under the old key would have to be re-encrypted
 * again. Trash, restore and permanent delete stay allowed (they do not touch ciphertext).
 */
export function assertVaultWritable(
  vault: Pick<Vault, "keyVersion" | "rotationPending">,
  keyVersion: number,
) {
  if (vault.rotationPending) throw rotationPending();
  if (vault.keyVersion !== keyVersion) {
    throw keyVersionMismatch({ currentKeyVersion: vault.keyVersion });
  }
}

/** SQL: the vault `vaultId` is at `keyVersion` and not waiting for a rotation. */
export function vaultAcceptsKeyVersion(
  db: Db,
  vaultId: SQLiteColumn | string,
  keyVersion: number,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(vaults)
      .where(
        and(
          eq(vaults.id, vaultId),
          eq(vaults.keyVersion, keyVersion),
          eq(vaults.rotationPending, false),
        ),
      ),
  );
}

/** SQL: the vault `vaultId` is not waiting for a rotation (any key version). */
export function vaultNotPending(db: Db, vaultId: SQLiteColumn | string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(vaults)
      .where(and(eq(vaults.id, vaultId), eq(vaults.rotationPending, false))),
  );
}

/** A guarded write changed no rows: re-read the vault and throw the precise reason. */
export async function throwVaultWriteFailure(
  db: Db,
  vaultId: string,
  keyVersion: number,
): Promise<never> {
  const vault = await db.select().from(vaults).where(eq(vaults.id, vaultId)).get();
  if (!vault) throw notFound();
  assertVaultWritable(vault, keyVersion);
  // Nothing wrong any more: the vault changed and changed back. Ask the client to retry.
  throw keyVersionMismatch({ currentKeyVersion: vault.keyVersion });
}
