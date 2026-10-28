// GET /api/sync?since=<ms> (PLAN.md 13, @pm/shared `syncResponseSchema`).
//
// Strategy
// - `serverTime` is the time the request STARTED (taken before any read). Clients store it and send
//   it as the next `since`. Rows are selected with `updated_at > since - SYNC_OVERLAP_MS`: writers
//   take their timestamp a few milliseconds before their batch commits, so a row stamped just
//   before `serverTime` can become visible just after our read. The overlap makes the next sync
//   repeat the last couple of seconds of changes instead of losing one. Apply rows idempotently
//   (upsert by id); apply `deletions` first, then upserts (an item moved A -> B -> A arrives as both).
// - Full sync when `since` is absent or older than the tombstone retention (90 days): no `since`
//   filter, `deletions` is empty and `full: true` (replace local state).
// - Pending (not yet accepted) invitations addressed to me are NOT included (GET /shares/pending).
//   Pending members / shares of MY vaults are included, so managers can list and re-seal them.
// - Incremental rules (a row is also re-sent when my own access to it changed, so a newly accepted
//   vault arrives complete): vault <- vault or my membership changed; members, items and item shares of a
//   vault <- the row changed OR my membership in that vault changed; shared items <- item or my share changed.
// - Tombstones: `user_id = me` OR (`user_id IS NULL` AND `vault_id` in my active vaults), newer
//   than `since`. See lib/vaults/tombstones.ts.
// - Item shares: shares addressed to me (active, with `sealedKey`) and every other share on items of
//   my vaults (without `sealedKey`). Items: everything in my vaults (trashed included) plus items
//   shared with me individually; a share recipient drops the item together with the share tombstone.
import { DELETION_TOMBSTONE_RETENTION_DAYS, syncQuerySchema } from "@pm/shared";
import { and, eq, gt, inArray, isNotNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import {
  deletions,
  type Item,
  type ItemShare,
  itemShares,
  items,
  users,
  type Vault,
  type VaultMember,
  vaultMembers,
  vaults,
} from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { validate } from "../lib/validate.ts";
import { runBatch } from "../lib/vaults/db.ts";
import { toItemShareWire, toItemWire, toMemberWire, toVaultWire } from "../lib/vaults/wire.ts";
import { getAuth, requireAuth } from "../middleware/session.ts";

/** Changes this close before the previous `serverTime` are sent again (see header comment). */
export const SYNC_OVERLAP_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const sync = new Hono<AppEnv>();

sync.use(requireAuth);

sync.get("/", validate("query", syncQuerySchema), async (c) => {
  const startedAt = Date.now();
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { since } = c.req.valid("query");

  const full =
    since === undefined || since < startedAt - DELETION_TOMBSTONE_RETENTION_DAYS * DAY_MS;
  const cutoff = full || since === undefined ? 0 : Math.max(0, since - SYNC_OVERLAP_MS);
  /** "Changed since the cutoff" over the given columns; no filter on a full sync. */
  const changed = (...columns: SQLiteColumn[]): SQL | undefined =>
    full ? undefined : or(...columns.map((column) => gt(column, cutoff)));

  const mine = alias(vaultMembers, "mine");
  const activeMine = and(eq(mine.userId, user.id), eq(mine.status, "active"));

  const [vaultRows, memberRows, itemRows, shareRows, deletionRows] = (await runBatch(db, [
    // Vaults I am an active member of.
    db
      .select({ vault: vaults, myRole: vaultMembers.role })
      .from(vaultMembers)
      .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
      .where(
        and(
          eq(vaultMembers.userId, user.id),
          eq(vaultMembers.status, "active"),
          changed(vaults.updatedAt, vaultMembers.updatedAt),
        ),
      ),
    // Members (any status) of those vaults, with their public identity.
    db
      .select({ member: vaultMembers, email: users.email, publicKey: users.publicKey })
      .from(vaultMembers)
      .innerJoin(mine, and(eq(mine.vaultId, vaultMembers.vaultId), activeMine))
      .innerJoin(users, eq(users.id, vaultMembers.userId))
      .where(changed(vaultMembers.updatedAt, mine.updatedAt)),
    // Items in my vaults, plus items shared with me individually (one row each).
    db
      .select({ item: items })
      .from(items)
      .leftJoin(
        vaultMembers,
        and(
          eq(vaultMembers.vaultId, items.vaultId),
          eq(vaultMembers.userId, user.id),
          eq(vaultMembers.status, "active"),
        ),
      )
      .leftJoin(
        itemShares,
        and(
          eq(itemShares.itemId, items.id),
          eq(itemShares.userId, user.id),
          eq(itemShares.status, "active"),
        ),
      )
      .where(
        and(
          or(isNotNull(vaultMembers.id), isNotNull(itemShares.id)),
          changed(items.updatedAt, vaultMembers.updatedAt, itemShares.updatedAt),
        ),
      ),
    // Shares addressed to me (active) and the other shares on items of my vaults.
    db
      .select({
        share: itemShares,
        vaultId: items.vaultId,
        email: users.email,
        publicKey: users.publicKey,
      })
      .from(itemShares)
      .innerJoin(items, eq(items.id, itemShares.itemId))
      .innerJoin(users, eq(users.id, itemShares.userId))
      .leftJoin(
        vaultMembers,
        and(
          eq(vaultMembers.vaultId, items.vaultId),
          eq(vaultMembers.userId, user.id),
          eq(vaultMembers.status, "active"),
        ),
      )
      .where(
        and(
          or(
            and(eq(itemShares.userId, user.id), eq(itemShares.status, "active")),
            and(isNotNull(vaultMembers.id), ne(itemShares.userId, user.id)),
          ),
          changed(itemShares.updatedAt, vaultMembers.updatedAt),
        ),
      ),
    // Tombstones (never on a full sync: the snapshot is complete).
    full
      ? db.select().from(deletions).where(sql`0`)
      : db
          .select()
          .from(deletions)
          .where(
            and(
              gt(deletions.deletedAt, cutoff),
              or(
                eq(deletions.userId, user.id),
                and(
                  sql`${deletions.userId} is null`,
                  inArray(
                    deletions.vaultId,
                    db
                      .select({ vaultId: vaultMembers.vaultId })
                      .from(vaultMembers)
                      .where(
                        and(eq(vaultMembers.userId, user.id), eq(vaultMembers.status, "active")),
                      ),
                  ),
                ),
              ),
            ),
          ),
  ])) as [
    { vault: Vault; myRole: VaultMember["role"] }[],
    { member: VaultMember; email: string; publicKey: string }[],
    { item: Item }[],
    { share: ItemShare; vaultId: string; email: string; publicKey: string }[],
    (typeof deletions.$inferSelect)[],
  ];

  return c.json({
    serverTime: startedAt,
    full,
    vaults: vaultRows.map((row) => toVaultWire(row.vault, row.myRole)),
    members: memberRows.map((row) => toMemberWire(row.member, row, row.member.userId === user.id)),
    items: itemRows.map((row) => toItemWire(row.item)),
    itemShares: shareRows.map((row) =>
      toItemShareWire(row.share, row, row.share.userId === user.id),
    ),
    deletions: deletionRows.map((row) => ({
      entity: row.entity,
      id: row.entityId,
      deletedAt: row.deletedAt,
    })),
  });
});
