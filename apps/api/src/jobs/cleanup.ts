import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  auditEvents,
  authChallenges,
  deletions,
  emailCodes,
  invites,
  itemShares,
  items,
  rateLimits,
  sessions,
} from "../db/schema.ts";
import { SESSION_IDLE_MS } from "../lib/sessions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_RETENTION_MS = 30 * DAY_MS;
export const EXPIRED_RECORD_RETENTION_MS = 30 * DAY_MS;
export const AUDIT_RETENTION_MS = 90 * DAY_MS;
export const TOMBSTONE_RETENTION_MS = 90 * DAY_MS;
export const RATE_LIMIT_RETENTION_MS = DAY_MS;

export interface CleanupResult {
  purgedItems: number;
  sessions: number;
  emailCodes: number;
  authChallenges: number;
  invites: number;
  auditEvents: number;
  tombstones: number;
  rateLimits: number;
}

/** `lower(hex(randomblob(16)))`: an id generated inside SQL for INSERT ... SELECT tombstones. */
const sqlId = sql<string>`lower(hex(randomblob(16)))`;

/**
 * The daily cron job (PLAN.md sections 4 and 16, Phase 3): one atomic `batch()` that
 * - purges items trashed for more than 30 days, recording tombstones first (the item for its
 *   vault members, and each item share for its recipient) so incremental sync can tell clients;
 * - deletes expired sessions (past `expires_at` or idle for 30 days);
 * - deletes email codes, auth challenges and invites more than 30 days past their expiry;
 * - deletes audit events older than 90 days, tombstones older than 90 days and stale rate limits.
 * Idempotent: running it twice in a row is a no-op the second time.
 */
export async function runCleanup(db: Db, now = Date.now()): Promise<CleanupResult> {
  const trashedBefore = now - TRASH_RETENTION_MS;
  const expiredBefore = now - EXPIRED_RECORD_RETENTION_MS;
  const purgeableItems = and(isNotNull(items.trashedAt), lt(items.trashedAt, trashedBefore));

  const results = await db.batch([
    // Tombstones must be written before the rows they describe disappear.
    db.insert(deletions).select(
      db
        .select({
          id: sqlId.as("id"),
          entity: sql<"item">`'item'`.as("entity"),
          entityId: items.id,
          vaultId: items.vaultId,
          userId: sql<string | null>`NULL`.as("user_id"),
          deletedAt: sql<number>`${now}`.as("deleted_at"),
        })
        .from(items)
        .where(purgeableItems),
    ),
    db.insert(deletions).select(
      db
        .select({
          id: sqlId.as("id"),
          entity: sql<"item_share">`'item_share'`.as("entity"),
          entityId: itemShares.id,
          vaultId: items.vaultId,
          userId: itemShares.userId,
          deletedAt: sql<number>`${now}`.as("deleted_at"),
        })
        .from(itemShares)
        .innerJoin(items, sql`${items.id} = ${itemShares.itemId}`)
        .where(purgeableItems),
    ),
    // Cascades to item_shares.
    db.delete(items).where(purgeableItems),
    db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, now - SESSION_IDLE_MS))),
    db.delete(emailCodes).where(lt(emailCodes.expiresAt, expiredBefore)),
    db.delete(authChallenges).where(lt(authChallenges.expiresAt, expiredBefore)),
    db.delete(invites).where(lt(invites.expiresAt, expiredBefore)),
    db.delete(auditEvents).where(lt(auditEvents.createdAt, now - AUDIT_RETENTION_MS)),
    db.delete(deletions).where(lt(deletions.deletedAt, now - TOMBSTONE_RETENTION_MS)),
    db.delete(rateLimits).where(lt(rateLimits.windowStart, now - RATE_LIMIT_RETENTION_MS)),
  ]);

  const changes = results.map((r) => (r as unknown as { meta: { changes: number } }).meta.changes);
  return {
    // Counted from the tombstone insert: D1's change count for the delete also includes cascades.
    purgedItems: changes[0] ?? 0,
    sessions: changes[3] ?? 0,
    emailCodes: changes[4] ?? 0,
    authChallenges: changes[5] ?? 0,
    invites: changes[6] ?? 0,
    auditEvents: changes[7] ?? 0,
    tombstones: changes[8] ?? 0,
    rateLimits: changes[9] ?? 0,
  };
}
