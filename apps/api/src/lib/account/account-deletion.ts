// Deleting a user (own deletion, admin delete, admin reset, self-service reset-account).
//
// Deleting the `users` row cascades to sessions, passkeys, backup codes, challenges, audit events,
// owned vaults (and through them members, items and item shares) and the user's memberships and
// item shares elsewhere. Other users' incremental sync only learns about that through tombstones
// (`deletions`), so those are written first, in the same batch, as INSERT ... SELECT statements
// that read the rows before the DELETE removes them. No SELECT-then-write race, no query loop.
//
// Tombstone rule (shared with the vault routes; `GET /sync` returns rows where `user_id = me`, or
// `user_id IS NULL AND vault_id` is one of my vaults):
//  - vault owned by the user: one `vault` tombstone per OTHER member, `user_id = member`
//  - item share on an item inside such a vault: one `item_share` tombstone per recipient,
//    `user_id = recipient`
//  - the user's membership in a vault they do not own: one `vault_member` tombstone,
//    `vault_id` set, `user_id` NULL (the remaining members drop the row)
//  - the user's item share on someone else's item: one `item_share` tombstone, `vault_id` of the
//    item's vault, `user_id` NULL (members of that vault drop the row)
import { and, eq, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../../db/client.ts";
import { deletions, itemShares, items, users, vaultMembers, vaults } from "../../db/schema.ts";

export type BatchStatement = BatchItem<"sqlite">;

/** `lower(hex(randomblob(16)))`: an id generated inside SQL for INSERT ... SELECT tombstones. */
const sqlId = sql<string>`lower(hex(randomblob(16)))`;

/**
 * Statements (for `db.batch`) that write the tombstones and then delete the user with everything
 * they own. Order matters: tombstones first, the DELETE last. Put your own inserts (e.g. the
 * replacement account) after this list.
 */
export function deleteUserStatements(
  db: Db,
  userId: string,
  now = Date.now(),
): [BatchStatement, ...BatchStatement[]] {
  const deletedAt = sql<number>`${now}`.as("deleted_at");
  return [
    // Vaults the user owns -> every other member.
    db.insert(deletions).select(
      db
        .select({
          id: sqlId.as("id"),
          entity: sql<"vault">`'vault'`.as("entity"),
          entityId: vaults.id,
          vaultId: vaults.id,
          userId: vaultMembers.userId,
          deletedAt,
        })
        .from(vaults)
        .innerJoin(vaultMembers, eq(vaultMembers.vaultId, vaults.id))
        .where(and(eq(vaults.ownerId, userId), ne(vaultMembers.userId, userId))),
    ),
    // Item shares on items inside owned vaults -> each recipient.
    db.insert(deletions).select(
      db
        .select({
          id: sqlId.as("id"),
          entity: sql<"item_share">`'item_share'`.as("entity"),
          entityId: itemShares.id,
          vaultId: items.vaultId,
          userId: itemShares.userId,
          deletedAt,
        })
        .from(itemShares)
        .innerJoin(items, eq(items.id, itemShares.itemId))
        .innerJoin(vaults, eq(vaults.id, items.vaultId))
        .where(eq(vaults.ownerId, userId)),
    ),
    // The user's memberships in vaults owned by others -> remaining members.
    db.insert(deletions).select(
      db
        .select({
          id: sqlId.as("id"),
          entity: sql<"vault_member">`'vault_member'`.as("entity"),
          entityId: vaultMembers.id,
          vaultId: vaultMembers.vaultId,
          userId: sql<string | null>`NULL`.as("user_id"),
          deletedAt,
        })
        .from(vaultMembers)
        .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
        .where(and(eq(vaultMembers.userId, userId), ne(vaults.ownerId, userId))),
    ),
    // The user's item shares on other people's items -> members of that item's vault.
    db.insert(deletions).select(
      db
        .select({
          id: sqlId.as("id"),
          entity: sql<"item_share">`'item_share'`.as("entity"),
          entityId: itemShares.id,
          vaultId: items.vaultId,
          userId: sql<string | null>`NULL`.as("user_id"),
          deletedAt,
        })
        .from(itemShares)
        .innerJoin(items, eq(items.id, itemShares.itemId))
        .innerJoin(vaults, eq(vaults.id, items.vaultId))
        .where(and(eq(itemShares.userId, userId), ne(vaults.ownerId, userId))),
    ),
    db.delete(users).where(eq(users.id, userId)),
  ];
}
