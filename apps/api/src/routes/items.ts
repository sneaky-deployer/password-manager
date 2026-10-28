// Item routes (PLAN.md 13, 11.1). The server stores ciphertext and decides who may write it.
//
// Who may do what (see lib/vaults/access.ts):
// - create / trash / restore / delete / move: vault members with role editor+ (item-share
//   recipients cannot trash, delete or move). Move needs editor+ in both vaults.
// - update (PUT): editor+ members, or an active item share with role `editor` (which must resend
//   `wrappedKey`, `vaultKeyVersion` and `itemKeyVersion` exactly as stored: it cannot wrap keys).
// - share / revoke an item share (routes below): manager+ members; a recipient may also remove their own.
//
// Rotation: while a vault has `rotation_pending` set, create / update / move return 409
// `rotation_pending`. Trash / restore / permanent delete stay allowed (no ciphertext changes).
// Key versions: writes carrying `vaultKeyVersion` must equal the vault's `key_version`, else 409
// `key_version_mismatch`. Revision: `revision` must equal the current one, else 409
// `revision_conflict` with `details.currentRevision`; it grows by one on update and move, not on
// trash / restore (those only touch `trashed_at` / `updated_at`).
//
// All "check then write" pairs repeat the check inside the write statement (guarded UPDATE /
// INSERT ... SELECT with RETURNING), so concurrent requests cannot interleave between them.
import {
  createItemRequestSchema,
  idParamsSchema,
  itemShareParamsSchema,
  moveItemRequestSchema,
  shareItemRequestSchema,
  updateItemRequestSchema,
} from "@pm/shared";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import {
  deletions,
  type Item,
  type ItemShare,
  itemShares,
  items as itemsTable,
  users,
  vaultMembers,
  vaults,
} from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { audit, auditStatement } from "../lib/audit.ts";
import { newId } from "../lib/crypto.ts";
import { AppError, isUniqueViolation } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { getItemAccess, getVaultAccess, hasRole, requireMemberRole } from "../lib/vaults/access.ts";
import {
  caseExpression,
  chunk,
  returnedRows,
  runBatch,
  type Stmt,
  sqlValue,
} from "../lib/vaults/db.ts";
import {
  conflict,
  forbidden,
  keyVersionMismatch,
  notFound,
  revisionConflict,
  rotationPending,
} from "../lib/vaults/errors.ts";
import {
  assertVaultWritable,
  throwVaultWriteFailure,
  vaultAcceptsKeyVersion,
  vaultNotPending,
} from "../lib/vaults/guards.ts";
import { emptyBody, maxBodyBytes } from "../lib/vaults/http.ts";
import { itemShareTombstonesForItem, tombstone } from "../lib/vaults/tombstones.ts";
import { toItemShareWire, toItemWire } from "../lib/vaults/wire.ts";
import { getAuth, requireAuth } from "../middleware/session.ts";

/** Bodies above this announce themselves as too large (item content is capped at ~96 KiB encoded). */
const MAX_ITEM_BODY_BYTES = 160 * 1024;
/** Share keys per CASE update statement (3 bound parameters each, D1 allows 100 per statement). */
const SHARE_KEYS_PER_STATEMENT = 25;

export const items = new Hono<AppEnv>();

items.use(requireAuth);

// --- Create ---------------------------------------------------------------------------------------

items.post(
  "/",
  maxBodyBytes(MAX_ITEM_BODY_BYTES),
  validate("json", createItemRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const body = c.req.valid("json");
    const now = Date.now();
    const { vault, member } = await getVaultAccess(db, body.vaultId, user.id);
    if (!hasRole(member.role, "editor")) throw forbidden();
    assertVaultWritable(vault, body.vaultKeyVersion);

    let rows: Item[];
    try {
      rows = await db
        .insert(itemsTable)
        .select(
          db
            .select({
              id: sqlValue(body.id, "id"),
              vaultId: vaults.id,
              itemKeyVersion: sqlValue(body.itemKeyVersion, "item_key_version"),
              wrappedKey: sqlValue(body.wrappedKey, "wrapped_key"),
              vaultKeyVersion: sqlValue(body.vaultKeyVersion, "vault_key_version"),
              encryptedData: sqlValue(body.encryptedData, "encrypted_data"),
              revision: sqlValue(1, "revision"),
              createdBy: sqlValue(user.id, "created_by"),
              updatedBy: sqlValue(user.id, "updated_by"),
              createdAt: sqlValue(now, "created_at"),
              updatedAt: sqlValue(now, "updated_at"),
              trashedAt: sql<number | null>`NULL`.as("trashed_at"),
            })
            .from(vaults)
            .where(
              and(
                eq(vaults.id, body.vaultId),
                vaultAcceptsKeyVersion(db, vaults.id, body.vaultKeyVersion),
              ),
            ),
        )
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("An item with this id already exists.");
      throw err;
    }
    const created = rows[0];
    if (!created) return throwVaultWriteFailure(db, body.vaultId, body.vaultKeyVersion);
    return c.json({ item: toItemWire(created) }, 201);
  },
);

// --- Update ---------------------------------------------------------------------------------------

items.put(
  "/:id",
  maxBodyBytes(MAX_ITEM_BODY_BYTES),
  validate("param", idParamsSchema),
  validate("json", updateItemRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const now = Date.now();
    const access = await getItemAccess(db, id, user.id);
    const { item, vault } = access;
    const viaMember = access.memberRole !== null && hasRole(access.memberRole, "editor");
    if (!viaMember && access.shareRole !== "editor") throw forbidden();
    if (vault.rotationPending) throw rotationPending();
    if (body.revision !== item.revision) throw revisionConflict(item.revision);

    if (!viaMember) {
      // Item-share editor: change the content only, keep every key field as stored.
      if (body.shareKeys && body.shareKeys.length > 0) throw forbidden();
      if (
        body.wrappedKey !== item.wrappedKey ||
        body.vaultKeyVersion !== item.vaultKeyVersion ||
        body.itemKeyVersion !== item.itemKeyVersion
      ) {
        throw keyVersionMismatch({
          currentItemKeyVersion: item.itemKeyVersion,
          currentVaultKeyVersion: item.vaultKeyVersion,
        });
      }
      const [updated] = await db
        .update(itemsTable)
        .set({
          encryptedData: body.encryptedData,
          revision: sql`${itemsTable.revision} + 1`,
          updatedBy: user.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(itemsTable.id, id),
            eq(itemsTable.revision, body.revision),
            eq(itemsTable.wrappedKey, item.wrappedKey),
            eq(itemsTable.vaultKeyVersion, item.vaultKeyVersion),
            eq(itemsTable.itemKeyVersion, item.itemKeyVersion),
            vaultNotPending(db, itemsTable.vaultId),
          ),
        )
        .returning();
      if (!updated) return throwItemWriteFailure(db, id, body.revision);
      return c.json({ item: toItemWire(updated) });
    }

    // Member path.
    assertVaultWritable(vault, body.vaultKeyVersion);
    const bump = body.itemKeyVersion === item.itemKeyVersion + 1;
    if (!bump && body.itemKeyVersion !== item.itemKeyVersion) {
      throw keyVersionMismatch({ currentItemKeyVersion: item.itemKeyVersion });
    }
    const shareKeys = body.shareKeys ?? [];
    if (!bump && shareKeys.length > 0) {
      throw new AppError(
        "validation_error",
        400,
        "shareKeys is only accepted together with a new itemKeyVersion",
      );
    }

    const statements: Stmt[] = [];
    const itemUnchanged = and(
      eq(itemsTable.id, id),
      eq(itemsTable.revision, body.revision),
      vaultAcceptsKeyVersion(db, itemsTable.vaultId, body.vaultKeyVersion),
    );
    if (bump) {
      // Item key rotation (after an item share was revoked): every remaining share must be re-sealed.
      const existing = await db
        .select({ id: itemShares.id })
        .from(itemShares)
        .where(eq(itemShares.itemId, id));
      const have = new Set(existing.map((row) => row.id));
      const provided = new Set(shareKeys.map((entry) => entry.shareId));
      const unknownShareIds = [...provided].filter((shareId) => !have.has(shareId));
      const missingShareIds = [...have].filter((shareId) => !provided.has(shareId));
      if (provided.size !== shareKeys.length || unknownShareIds.length > 0) {
        throw new AppError(
          "validation_error",
          400,
          "shareKeys has duplicate or unknown share ids",
          {
            unknownShareIds,
          },
        );
      }
      if (missingShareIds.length > 0) {
        throw conflict("The new item key must be sealed for every item share.", {
          missingShareIds,
        });
      }
      // Share updates run BEFORE the item update and are gated by the item's current state, so
      // either both apply or neither does.
      for (const group of chunk(shareKeys, SHARE_KEYS_PER_STATEMENT)) {
        statements.push(
          db
            .update(itemShares)
            .set({
              sealedKey: caseExpression(
                itemShares.id,
                group.map((entry) => ({ id: entry.shareId, value: entry.sealedKey })),
              ),
              keyVersion: body.itemKeyVersion,
              updatedAt: now,
            })
            .where(
              and(
                eq(itemShares.itemId, id),
                inArray(
                  itemShares.id,
                  group.map((entry) => entry.shareId),
                ),
                sql`exists (select 1 from ${itemsTable} where ${itemUnchanged})`,
              ),
            ),
        );
      }
    }
    statements.push(
      db
        .update(itemsTable)
        .set({
          itemKeyVersion: body.itemKeyVersion,
          wrappedKey: body.wrappedKey,
          vaultKeyVersion: body.vaultKeyVersion,
          encryptedData: body.encryptedData,
          revision: sql`${itemsTable.revision} + 1`,
          updatedBy: user.id,
          updatedAt: now,
        })
        .where(itemUnchanged)
        .returning(),
    );
    const results = await runBatch(db, statements);
    const updated = returnedRows<Item>(results[results.length - 1])[0];
    if (!updated) return throwItemWriteFailure(db, id, body.revision);
    return c.json({ item: toItemWire(updated) });
  },
);

/** A guarded item write changed nothing: say why (gone, stale revision, rotation, ...). */
async function throwItemWriteFailure(
  db: ReturnType<typeof getDb>,
  itemId: string,
  revision: number,
): Promise<never> {
  const row = await db
    .select({ item: itemsTable, vault: vaults })
    .from(itemsTable)
    .innerJoin(vaults, eq(vaults.id, itemsTable.vaultId))
    .where(eq(itemsTable.id, itemId))
    .get();
  if (!row) throw notFound();
  if (row.item.revision !== revision) throw revisionConflict(row.item.revision);
  if (row.vault.rotationPending) throw rotationPending();
  throw keyVersionMismatch({ currentKeyVersion: row.vault.keyVersion });
}

// --- Trash / restore / delete ---------------------------------------------------------------------

items.post("/:id/trash", validate("param", idParamsSchema), emptyBody, async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const access = await getItemAccess(db, id, user.id);
  requireMemberRole(access, "editor");
  if (access.item.trashedAt !== null) return c.json({ item: toItemWire(access.item) });
  const now = Date.now();
  const [updated] = await db
    .update(itemsTable)
    .set({ trashedAt: now, updatedAt: now, updatedBy: user.id })
    .where(and(eq(itemsTable.id, id), isNull(itemsTable.trashedAt)))
    .returning();
  return c.json({ item: toItemWire(updated ?? access.item) });
});

items.post("/:id/restore", validate("param", idParamsSchema), emptyBody, async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const access = await getItemAccess(db, id, user.id);
  requireMemberRole(access, "editor");
  if (access.item.trashedAt === null) return c.json({ item: toItemWire(access.item) });
  const now = Date.now();
  const [updated] = await db
    .update(itemsTable)
    .set({ trashedAt: null, updatedAt: now, updatedBy: user.id })
    .where(and(eq(itemsTable.id, id), isNotNull(itemsTable.trashedAt)))
    .returning();
  return c.json({ item: toItemWire(updated ?? access.item) });
});

items.delete("/:id", validate("param", idParamsSchema), async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const now = Date.now();
  const access = await getItemAccess(db, id, user.id);
  requireMemberRole(access, "editor");
  if (access.item.trashedAt === null) {
    throw conflict("Move the item to the trash before deleting it permanently.");
  }
  const vaultId = access.item.vaultId;
  // Tombstones: members of the vault drop the item, share recipients drop their share (and with
  // it the item). Both are written before the delete, which cascades away the shares.
  await runBatch(db, [
    tombstone(db, { entity: "item", entityId: id, vaultId, userId: null }, now),
    itemShareTombstonesForItem(db, id, vaultId, now),
    db.delete(itemsTable).where(and(eq(itemsTable.id, id), isNotNull(itemsTable.trashedAt))),
  ]);
  return c.json({ ok: true as const });
});

// --- Move -----------------------------------------------------------------------------------------

items.post(
  "/:id/move",
  validate("param", idParamsSchema),
  validate("json", moveItemRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const now = Date.now();
    const access = await getItemAccess(db, id, user.id);
    requireMemberRole(access, "editor");
    const { item, vault: source } = access;
    if (body.targetVaultId === source.id) {
      throw new AppError("validation_error", 400, "The item is already in this vault.");
    }
    const { vault: target, member } = await getVaultAccess(db, body.targetVaultId, user.id);
    if (!hasRole(member.role, "editor")) throw forbidden();
    if (source.rotationPending) throw rotationPending();
    assertVaultWritable(target, body.vaultKeyVersion);
    if (body.revision !== item.revision) throw revisionConflict(item.revision);

    const targetOpen = vaultAcceptsKeyVersion(db, body.targetVaultId, body.vaultKeyVersion);
    const unchanged = and(
      eq(itemsTable.id, id),
      eq(itemsTable.revision, body.revision),
      eq(itemsTable.vaultId, source.id),
      targetOpen,
      vaultNotPending(db, source.id),
    );
    const results = await runBatch(db, [
      // The old vault's members drop the item. Only if the move below will apply.
      db.insert(deletions).select(
        db
          .select({
            id: sql<string>`lower(hex(randomblob(16)))`.as("id"),
            entity: sql<"item">`'item'`.as("entity"),
            entityId: itemsTable.id,
            vaultId: itemsTable.vaultId,
            userId: sql<string | null>`NULL`.as("user_id"),
            deletedAt: sqlValue(now, "deleted_at"),
          })
          .from(itemsTable)
          .where(unchanged),
      ),
      db
        .update(itemsTable)
        .set({
          vaultId: body.targetVaultId,
          wrappedKey: body.wrappedKey,
          vaultKeyVersion: body.vaultKeyVersion,
          revision: sql`${itemsTable.revision} + 1`,
          updatedBy: user.id,
          updatedAt: now,
        })
        .where(unchanged)
        .returning(),
    ]);
    const moved = returnedRows<Item>(results[1])[0];
    if (!moved) return throwItemWriteFailure(db, id, body.revision);
    return c.json({ item: toItemWire(moved) });
  },
);

// --- Single-item shares ---------------------------------------------------------------------------
// Share: manager+ members of the item's vault (granting access to a person is a member-management
// action; item-share recipients cannot re-share). The recipient must be an active user who is not
// already a member (or invitee) of that vault and has no share on the item yet.

items.post(
  "/:id/shares",
  validate("param", idParamsSchema),
  validate("json", shareItemRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const now = Date.now();
    const access = await getItemAccess(db, id, user.id);
    requireMemberRole(access, "manager");
    const { item, vault } = access;
    if (vault.rotationPending) throw rotationPending();
    if (body.keyVersion !== item.itemKeyVersion) {
      throw keyVersionMismatch({ currentItemKeyVersion: item.itemKeyVersion });
    }
    if (body.userId === user.id) {
      throw new AppError("validation_error", 400, "You cannot share an item with yourself.");
    }

    const [recipientRows, membershipRows] = (await runBatch(db, [
      db
        .select({
          id: users.id,
          email: users.email,
          publicKey: users.publicKey,
          status: users.status,
        })
        .from(users)
        .where(eq(users.id, body.userId)),
      db
        .select({ id: vaultMembers.id })
        .from(vaultMembers)
        .where(and(eq(vaultMembers.vaultId, vault.id), eq(vaultMembers.userId, body.userId))),
    ])) as [{ id: string; email: string; publicKey: string; status: string }[], { id: string }[]];
    const recipient = recipientRows[0];
    if (recipient?.status !== "active") throw notFound();
    if (membershipRows.length > 0) {
      throw conflict("This user already has access to the vault.");
    }

    let rows: ItemShare[];
    try {
      rows = await db
        .insert(itemShares)
        .select(
          db
            .select({
              id: sqlValue(newId(), "id"),
              itemId: itemsTable.id,
              userId: sqlValue(recipient.id, "user_id"),
              role: sqlValue(body.role, "role"),
              keyVersion: sqlValue(body.keyVersion, "key_version"),
              sealedKey: sqlValue(body.sealedKey, "sealed_key"),
              status: sqlValue("pending" as const, "status"),
              invitedBy: sqlValue(user.id, "invited_by"),
              createdAt: sqlValue(now, "created_at"),
              updatedAt: sqlValue(now, "updated_at"),
            })
            .from(itemsTable)
            .where(
              and(
                eq(itemsTable.id, id),
                eq(itemsTable.itemKeyVersion, body.keyVersion),
                vaultNotPending(db, itemsTable.vaultId),
              ),
            ),
        )
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("This item is already shared with that user.");
      throw err;
    }
    const share = rows[0];
    if (!share) return throwItemWriteFailure(db, id, item.revision);
    await audit(db, user.id, "share_created", { kind: "item", itemId: id, role: body.role }, now);
    return c.json(
      { share: toItemShareWire(share, { vaultId: vault.id, ...recipient }, false) },
      201,
    );
  },
);

// Revoke: manager+ members, or the recipient removing their own share. Afterwards the client
// rotates the item key with `PUT /items/:id` + `shareKeys`.
items.delete("/:id/shares/:shareId", validate("param", itemShareParamsSchema), async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id, shareId } = c.req.valid("param");
  const now = Date.now();
  const access = await getItemAccess(db, id, user.id);
  const share = await db
    .select()
    .from(itemShares)
    .where(and(eq(itemShares.id, shareId), eq(itemShares.itemId, id)))
    .get();
  if (!share) throw notFound();
  const isManager = access.memberRole !== null && hasRole(access.memberRole, "manager");
  if (!isManager && share.userId !== user.id) throw forbidden();
  const vaultId = access.item.vaultId;

  await runBatch(db, [
    // The recipient drops the share (and the item); vault members drop it from their share list.
    tombstone(db, { entity: "item_share", entityId: shareId, vaultId, userId: share.userId }, now),
    tombstone(db, { entity: "item_share", entityId: shareId, vaultId, userId: null }, now),
    db.delete(itemShares).where(eq(itemShares.id, shareId)),
    auditStatement(
      db,
      user.id,
      "share_revoked",
      { kind: "item", itemId: id, status: share.status },
      now,
    ),
  ]);
  return c.json({ ok: true as const });
});
