// Tombstones for incremental sync (table `deletions`, PLAN.md 13). The visibility rule that sync
// applies (routes/sync.ts) is shared with the account routes:
//
//   a tombstone is returned to user U when  user_id = U
//                                      OR  (user_id IS NULL AND vault_id IN U's active vaults)
//
// So: `user_id` set = only that user is told; `user_id` NULL + `vault_id` = every current member of
// that vault is told. Build the statements with the helpers below and put them in the same
// `batch()` as the delete they describe, BEFORE the delete when they are INSERT ... SELECT.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type DeletionEntity,
  deletions,
  itemShares,
  items,
  vaultMembers,
} from "../../db/schema.ts";
import { newId } from "../crypto.ts";

/** `lower(hex(randomblob(16)))`: an id generated inside SQL for INSERT ... SELECT tombstones. */
const sqlId = sql<string>`lower(hex(randomblob(16)))`;

export interface TombstoneInput {
  entity: DeletionEntity;
  entityId: string;
  vaultId: string | null;
  userId: string | null;
}

/** One tombstone row. */
export function tombstone(db: Db, input: TombstoneInput, now: number) {
  return db.insert(deletions).values({ id: newId(), ...input, deletedAt: now });
}

/** One `vault` tombstone per current membership (any status) of the vault, addressed to that user. */
export function vaultTombstonesForMembers(db: Db, vaultId: string, now: number) {
  return db.insert(deletions).select(
    db
      .select({
        id: sqlId.as("id"),
        entity: sql<"vault">`'vault'`.as("entity"),
        entityId: sql<string>`${vaultId}`.as("entity_id"),
        vaultId: sql<string>`${vaultId}`.as("vault_id"),
        userId: vaultMembers.userId,
        deletedAt: sql<number>`${now}`.as("deleted_at"),
      })
      .from(vaultMembers)
      .where(eq(vaultMembers.vaultId, vaultId)),
  );
}

/** One `item_share` tombstone per share on any item of the vault, addressed to the recipient. */
export function itemShareTombstonesForVault(db: Db, vaultId: string, now: number) {
  return db.insert(deletions).select(
    db
      .select({
        id: sqlId.as("id"),
        entity: sql<"item_share">`'item_share'`.as("entity"),
        entityId: itemShares.id,
        vaultId: sql<string>`${vaultId}`.as("vault_id"),
        userId: itemShares.userId,
        deletedAt: sql<number>`${now}`.as("deleted_at"),
      })
      .from(itemShares)
      .innerJoin(items, eq(items.id, itemShares.itemId))
      .where(eq(items.vaultId, vaultId)),
  );
}

/** One `item_share` tombstone per share on one item, addressed to the recipient. */
export function itemShareTombstonesForItem(db: Db, itemId: string, vaultId: string, now: number) {
  return db.insert(deletions).select(
    db
      .select({
        id: sqlId.as("id"),
        entity: sql<"item_share">`'item_share'`.as("entity"),
        entityId: itemShares.id,
        vaultId: sql<string>`${vaultId}`.as("vault_id"),
        userId: itemShares.userId,
        deletedAt: sql<number>`${now}`.as("deleted_at"),
      })
      .from(itemShares)
      .where(eq(itemShares.itemId, itemId)),
  );
}
