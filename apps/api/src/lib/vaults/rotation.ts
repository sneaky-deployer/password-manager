// Vault key rotation (PLAN.md 11.4, @pm/shared `rotateVaultRequestSchema`).
//
// Design
// - `step: "chunk"` validates the uploaded items against the live rows and upserts them into the
//   staging table `vault_rotation_items` (PK vault_id + item_id, so re-sending a chunk is
//   idempotent). Nothing live changes, so the other members keep working until the switch.
// - `step: "finalize"` re-checks everything and applies it in ONE `batch()`:
//     0. guarded UPDATE of the vault (key_version = new, encrypted_meta, rotation_pending = 0). Its
//        WHERE clause is the real transaction guard: the vault must still be at the old key
//        version, every item in it must have a staged row at the new version whose revision still
//        equals the live revision, and the member / item-share counts must be what the pre-check saw.
//     1. UPDATE items ... FROM the staging table (one statement for all items; revision + 1).
//     2. UPDATE vault_members sealed keys (CASE ... END, 40 members per statement).
//     3. UPDATE item_shares sealed keys, key_version = the item's new key version.
//     4. DELETE the staged rows.
//   Statements 1-4 only act when statement 0 took effect (they test `vaults.key_version = new`) and
//   are idempotent on their own (staging rows disappear, `key_version < new` no longer holds), so a
//   concurrent second finalize cannot apply anything twice. If statement 0 changed nothing the
//   whole batch is a no-op and the client gets 409 and restarts the rotation.
// - Item writes (create/update/move) are rejected with 409 `rotation_pending` while
//   `rotation_pending` is set, and member invites / item shares as well; see routes/vaults.ts.
//   A voluntary rotation (no member removed) is also allowed: the SQL guard in step 0 then makes
//   a concurrent item edit fail the finalize instead of being overwritten.
import type { RotateVaultChunkRequest, RotateVaultFinalizeRequest } from "@pm/shared";
import { and, eq, exists, inArray, lt, notExists, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  itemShares,
  items,
  type Vault,
  vaultMembers,
  vaultRotationItems,
  vaults,
} from "../../db/schema.ts";
import { audit } from "../audit.ts";
import { AppError } from "../errors.ts";
import { caseExpression, chunk, returnedRows, runBatch, type Stmt } from "./db.ts";
import { conflict, keyVersionMismatch, revisionConflict } from "./errors.ts";

/** D1 allows 100 bound parameters per statement. Staging rows have 8 columns -> 10 rows = 80. */
const STAGE_ROWS_PER_STATEMENT = 10;
/** CASE update: 3 parameters per key (id in CASE, value, id in IN) plus about 10 fixed. */
const KEYS_PER_STATEMENT = 25;
/** Parameters for the `inArray(items.id, ...)` lookups (D1 limit is 100). */
const IDS_PER_SELECT = 90;

function assertNewKeyVersion(vault: Vault, newKeyVersion: number) {
  if (newKeyVersion !== vault.keyVersion + 1) {
    throw keyVersionMismatch({
      currentKeyVersion: vault.keyVersion,
      expectedNewKeyVersion: vault.keyVersion + 1,
    });
  }
}

/** Stages a chunk of re-encrypted items. Returns how many were accepted. */
export async function stageRotationChunk(
  db: Db,
  vault: Vault,
  body: RotateVaultChunkRequest,
  now: number,
): Promise<number> {
  assertNewKeyVersion(vault, body.newKeyVersion);

  const ids = body.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new AppError("validation_error", 400, "Duplicate item ids in one chunk");
  }

  // Current state of those items (ids only, so at most 90 parameters per select, one batch).
  const lookups = chunk(ids, IDS_PER_SELECT).map((group) =>
    db
      .select({
        id: items.id,
        vaultId: items.vaultId,
        revision: items.revision,
        itemKeyVersion: items.itemKeyVersion,
      })
      .from(items)
      .where(inArray(items.id, group)),
  );
  const found = (await runBatch(db, lookups)).flatMap((rows) =>
    returnedRows<{ id: string; vaultId: string; revision: number; itemKeyVersion: number }>(rows),
  );
  const live = new Map(found.filter((row) => row.vaultId === vault.id).map((row) => [row.id, row]));

  const unknown = ids.filter((id) => !live.has(id));
  if (unknown.length > 0) {
    throw conflict("Some items are not in this vault (anymore).", { unknownItemIds: unknown });
  }
  const stale: { id: string; currentRevision: number }[] = [];
  for (const item of body.items) {
    const row = live.get(item.id);
    if (!row) continue;
    if (item.vaultKeyVersion !== body.newKeyVersion) {
      throw keyVersionMismatch({ itemId: item.id, expectedVaultKeyVersion: body.newKeyVersion });
    }
    if (item.itemKeyVersion <= row.itemKeyVersion) {
      throw new AppError(
        "validation_error",
        400,
        "A rotated item needs a new item key version (item key version must increase)",
        { itemId: item.id, currentItemKeyVersion: row.itemKeyVersion },
      );
    }
    if (item.revision !== row.revision) stale.push({ id: item.id, currentRevision: row.revision });
  }
  if (stale.length > 0) {
    throw revisionConflict(stale[0]?.currentRevision ?? 0, { staleItems: stale });
  }

  const statements: Stmt[] = chunk(body.items, STAGE_ROWS_PER_STATEMENT).map((group) =>
    db
      .insert(vaultRotationItems)
      .values(
        group.map((item) => ({
          vaultId: vault.id,
          itemId: item.id,
          newKeyVersion: body.newKeyVersion,
          revision: item.revision,
          wrappedKey: item.wrappedKey,
          encryptedData: item.encryptedData,
          itemKeyVersion: item.itemKeyVersion,
          createdAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [vaultRotationItems.vaultId, vaultRotationItems.itemId],
        set: {
          newKeyVersion: sql`excluded.new_key_version`,
          revision: sql`excluded.revision`,
          wrappedKey: sql`excluded.wrapped_key`,
          encryptedData: sql`excluded.encrypted_data`,
          itemKeyVersion: sql`excluded.item_key_version`,
          createdAt: sql`excluded.created_at`,
        },
      }),
  );
  await runBatch(db, statements);
  return body.items.length;
}

/** Validates and applies a finalize request in one batch. Returns the updated vault row. */
export async function finalizeRotation(
  db: Db,
  vault: Vault,
  body: RotateVaultFinalizeRequest,
  userId: string,
  now: number,
): Promise<Vault> {
  assertNewKeyVersion(vault, body.newKeyVersion);
  const newKeyVersion = body.newKeyVersion;
  const vaultId = vault.id;

  const memberIds = body.memberKeys.map((entry) => entry.memberId);
  const shareIds = body.itemShareKeys.map((entry) => entry.shareId);
  if (new Set(memberIds).size !== memberIds.length || new Set(shareIds).size !== shareIds.length) {
    throw new AppError("validation_error", 400, "Duplicate ids in memberKeys or itemShareKeys");
  }

  // One batch of reads (a single subrequest): items with their staged rows, members, item shares.
  const [itemRows, memberRows, shareRows] = (await runBatch(db, [
    db
      .select({
        id: items.id,
        revision: items.revision,
        // Aliased: batched selects collapse columns that share a SQL name (items.revision).
        stagedRevision: sql<number | null>`${vaultRotationItems.revision}`.as("staged_revision"),
      })
      .from(items)
      .leftJoin(
        vaultRotationItems,
        and(
          eq(vaultRotationItems.itemId, items.id),
          eq(vaultRotationItems.vaultId, items.vaultId),
          eq(vaultRotationItems.newKeyVersion, newKeyVersion),
        ),
      )
      .where(eq(items.vaultId, vaultId)),
    db.select({ id: vaultMembers.id }).from(vaultMembers).where(eq(vaultMembers.vaultId, vaultId)),
    db
      .select({ id: itemShares.id })
      .from(itemShares)
      .innerJoin(items, eq(items.id, itemShares.itemId))
      .where(eq(items.vaultId, vaultId)),
  ])) as [
    { id: string; revision: number; stagedRevision: number | null }[],
    { id: string }[],
    { id: string }[],
  ];

  const missingItemIds = itemRows.filter((row) => row.stagedRevision === null).map((row) => row.id);
  if (missingItemIds.length > 0) {
    throw conflict("Some items were not uploaded for the new key version.", { missingItemIds });
  }
  const stale = itemRows.filter((row) => row.stagedRevision !== row.revision);
  if (stale.length > 0) {
    throw revisionConflict(stale[0]?.revision ?? 0, {
      staleItemIds: stale.map((row) => row.id),
    });
  }

  const memberSet = new Set(memberRows.map((row) => row.id));
  const unknownMembers = memberIds.filter((id) => !memberSet.has(id));
  if (unknownMembers.length > 0) {
    throw new AppError("validation_error", 400, "memberKeys contains unknown member ids", {
      unknownMemberIds: unknownMembers,
    });
  }
  const providedMembers = new Set(memberIds);
  const missingMemberIds = [...memberSet].filter((id) => !providedMembers.has(id));
  if (missingMemberIds.length > 0) {
    throw conflict("The new vault key must be sealed for every member.", { missingMemberIds });
  }

  const shareSet = new Set(shareRows.map((row) => row.id));
  const unknownShares = shareIds.filter((id) => !shareSet.has(id));
  if (unknownShares.length > 0) {
    throw new AppError("validation_error", 400, "itemShareKeys contains unknown share ids", {
      unknownShareIds: unknownShares,
    });
  }
  const providedShares = new Set(shareIds);
  const missingShareIds = [...shareSet].filter((id) => !providedShares.has(id));
  if (missingShareIds.length > 0) {
    throw conflict("The new item keys must be sealed for every item share.", { missingShareIds });
  }

  // Statements 1-4 run only when statement 0 took effect and are idempotent (see file header).
  const vaultSwitched = exists(
    db
      .select({ one: sql`1` })
      .from(vaults)
      .where(and(eq(vaults.id, vaultId), eq(vaults.keyVersion, newKeyVersion))),
  );
  const itemsStagedFor = db
    .select({ one: sql`1` })
    .from(vaultRotationItems)
    .where(
      and(
        eq(vaultRotationItems.itemId, items.id),
        eq(vaultRotationItems.vaultId, vaults.id),
        eq(vaultRotationItems.newKeyVersion, newKeyVersion),
        eq(vaultRotationItems.revision, items.revision),
      ),
    );

  const statements: Stmt[] = [
    // 0. The guard.
    db
      .update(vaults)
      .set({
        keyVersion: newKeyVersion,
        encryptedMeta: body.encryptedMeta,
        rotationPending: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(vaults.id, vaultId),
          eq(vaults.keyVersion, vault.keyVersion),
          notExists(
            db
              .select({ one: sql`1` })
              .from(items)
              .where(and(eq(items.vaultId, vaults.id), notExists(itemsStagedFor))),
          ),
          sql`(select count(*) from ${vaultMembers} where ${vaultMembers.vaultId} = ${vaults.id}) = ${memberRows.length}`,
          sql`(select count(*) from ${itemShares} where ${itemShares.itemId} in (select ${items.id} from ${items} where ${items.vaultId} = ${vaults.id})) = ${shareRows.length}`,
        ),
      )
      .returning({ id: vaults.id }),
    // 1. Swap every staged item in.
    db
      .update(items)
      .set({
        itemKeyVersion: vaultRotationItems.itemKeyVersion,
        wrappedKey: vaultRotationItems.wrappedKey,
        vaultKeyVersion: vaultRotationItems.newKeyVersion,
        encryptedData: vaultRotationItems.encryptedData,
        revision: sql`${items.revision} + 1`,
        updatedAt: now,
      })
      .from(vaultRotationItems)
      .where(
        and(
          eq(items.id, vaultRotationItems.itemId),
          eq(items.vaultId, vaultId),
          eq(vaultRotationItems.vaultId, vaultId),
          eq(vaultRotationItems.newKeyVersion, newKeyVersion),
          eq(vaultRotationItems.revision, items.revision),
          vaultSwitched,
        ),
      ),
  ];

  // 2. Member keys.
  for (const group of chunk(body.memberKeys, KEYS_PER_STATEMENT)) {
    statements.push(
      db
        .update(vaultMembers)
        .set({
          sealedKey: caseExpression(
            vaultMembers.id,
            group.map((entry) => ({ id: entry.memberId, value: entry.sealedKey })),
          ),
          keyVersion: newKeyVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(vaultMembers.vaultId, vaultId),
            inArray(
              vaultMembers.id,
              group.map((entry) => entry.memberId),
            ),
            lt(vaultMembers.keyVersion, newKeyVersion),
            vaultSwitched,
          ),
        ),
    );
  }

  // 3. Item-share keys: sealed new item keys; key_version follows the (already swapped) item.
  const itemKeyVersionOfShare = sql`(select ${items.itemKeyVersion} from ${items} where ${items.id} = ${itemShares.itemId})`;
  for (const group of chunk(body.itemShareKeys, KEYS_PER_STATEMENT)) {
    statements.push(
      db
        .update(itemShares)
        .set({
          sealedKey: caseExpression(
            itemShares.id,
            group.map((entry) => ({ id: entry.shareId, value: entry.sealedKey })),
          ),
          keyVersion: itemKeyVersionOfShare,
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              itemShares.id,
              group.map((entry) => entry.shareId),
            ),
            sql`${itemShares.itemId} in (select ${items.id} from ${items} where ${items.vaultId} = ${vaultId})`,
            sql`${itemShares.keyVersion} < ${itemKeyVersionOfShare}`,
            vaultSwitched,
          ),
        ),
    );
  }

  // 4. Staging rows are done with.
  statements.push(
    db
      .delete(vaultRotationItems)
      .where(and(eq(vaultRotationItems.vaultId, vaultId), vaultSwitched)),
  );

  const results = await runBatch(db, statements);
  if (returnedRows(results[0]).length === 0) {
    // Another request changed the vault between our checks and the batch; nothing was applied.
    throw conflict("The vault changed while it was being rotated. Restart the rotation.", {
      reason: "vault_changed",
    });
  }

  await audit(db, userId, "vault_rotated", { vaultId, keyVersion: newKeyVersion }, now);
  const updated = await db.select().from(vaults).where(eq(vaults.id, vaultId)).get();
  if (!updated) throw conflict("The vault no longer exists.");
  return updated;
}
