// Vault routes: create/rename/delete, members, leave, key rotation (PLAN.md 11).
//
// Role decisions (PLAN.md 11.1; see lib/vaults/access.ts):
// - Non-members and pending members get 404 for everything; members with a too-low role get 403.
// - PATCH vault (metadata): manager+.            DELETE vault: owner only.
// - Invite member: manager+. A manager can invite viewers/editors only; only the owner can add a
//   manager. Invites are blocked (409 rotation_pending) while a rotation is pending, because the
//   rotation must seal the new key for every member and the member set must not grow under it.
// - Change role: manager+, never the owner's role. A manager can only change viewers/editors (to
//   viewer/editor); only the owner can promote to or demote a manager.
// - Remove member: manager+, never the owner. A manager can remove viewers/editors only; only the
//   owner can remove a manager. Always sets `rotation_pending` (also for a pending invitee, who
//   could already have fetched the sealed key through GET /shares/pending).
// - Leave: any non-owner active member, no rotation (PLAN.md 11.5). The owner deletes the vault.
// - Rotate: owner or manager.
// There is no ownership-transfer endpoint in the shared contract.
//
// Metadata PATCH is also blocked while a rotation is pending (the finalize step replaces it).
import {
  createVaultRequestSchema,
  idParamsSchema,
  inviteMemberRequestSchema,
  rotateVaultRequestSchema,
  updateMemberRequestSchema,
  updateVaultRequestSchema,
  vaultMemberParamsSchema,
} from "@pm/shared";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import {
  users,
  type Vault,
  type VaultMember,
  vaultMembers,
  vaults as vaultsTable,
} from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { audit, auditStatement } from "../lib/audit.ts";
import { newId } from "../lib/crypto.ts";
import { isUniqueViolation } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { getVaultAccess, requireRole } from "../lib/vaults/access.ts";
import { returnedRows, runBatch, sqlValue } from "../lib/vaults/db.ts";
import { conflict, forbidden, notFound } from "../lib/vaults/errors.ts";
import {
  assertVaultWritable,
  throwVaultWriteFailure,
  vaultAcceptsKeyVersion,
} from "../lib/vaults/guards.ts";
import { emptyBody } from "../lib/vaults/http.ts";
import { finalizeRotation, stageRotationChunk } from "../lib/vaults/rotation.ts";
import {
  itemShareTombstonesForVault,
  tombstone,
  vaultTombstonesForMembers,
} from "../lib/vaults/tombstones.ts";
import { toMemberWire, toVaultWire } from "../lib/vaults/wire.ts";
import { getAuth, requireAuth } from "../middleware/session.ts";

/** A membership of the vault together with the member's public identity. */
async function getMemberOfVault(db: ReturnType<typeof getDb>, vaultId: string, memberId: string) {
  const row = await db
    .select({ member: vaultMembers, email: users.email, publicKey: users.publicKey })
    .from(vaultMembers)
    .innerJoin(users, eq(users.id, vaultMembers.userId))
    .where(and(eq(vaultMembers.id, memberId), eq(vaultMembers.vaultId, vaultId)))
    .get();
  if (!row) throw notFound();
  return row;
}

export const vaults = new Hono<AppEnv>();

vaults.use(requireAuth);

// --- Create / update / delete ---------------------------------------------------------------------

vaults.post("/", validate("json", createVaultRequestSchema), async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const body = c.req.valid("json");
  const now = Date.now();
  const memberId = newId();

  let results: unknown[];
  try {
    results = await runBatch(db, [
      db
        .insert(vaultsTable)
        .values({
          id: body.id,
          ownerId: user.id,
          keyVersion: 1,
          encryptedMeta: body.encryptedMeta,
          rotationPending: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      db
        .insert(vaultMembers)
        .values({
          id: memberId,
          vaultId: body.id,
          userId: user.id,
          role: "owner",
          keyVersion: 1,
          sealedKey: body.sealedKey,
          status: "active",
          invitedBy: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A vault with this id already exists.");
    throw err;
  }
  const vault = returnedRows<Vault>(results[0])[0];
  const member = returnedRows<VaultMember>(results[1])[0];
  if (!vault || !member) throw new Error("vault insert returned no row");
  return c.json(
    { vault: toVaultWire(vault, "owner"), member: toMemberWire(member, user, true) },
    201,
  );
});

vaults.patch(
  "/:id",
  validate("param", idParamsSchema),
  validate("json", updateVaultRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { vault, member } = await getVaultAccess(db, id, user.id);
    requireRole(member.role, "manager");
    assertVaultWritable(vault, body.keyVersion);

    const [updated] = await db
      .update(vaultsTable)
      .set({ encryptedMeta: body.encryptedMeta, updatedAt: Date.now() })
      .where(
        and(eq(vaultsTable.id, id), vaultAcceptsKeyVersion(db, vaultsTable.id, body.keyVersion)),
      )
      .returning();
    if (!updated) return throwVaultWriteFailure(db, id, body.keyVersion);
    return c.json({ vault: toVaultWire(updated, member.role) });
  },
);

vaults.delete("/:id", validate("param", idParamsSchema), async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const now = Date.now();
  const { member } = await getVaultAccess(db, id, user.id);
  requireRole(member.role, "owner");

  // Tombstones first (they read memberships and item shares that the delete cascades away).
  await runBatch(db, [
    vaultTombstonesForMembers(db, id, now),
    itemShareTombstonesForVault(db, id, now),
    auditStatement(db, user.id, "vault_deleted", { vaultId: id }, now),
    db.delete(vaultsTable).where(eq(vaultsTable.id, id)),
  ]);
  return c.json({ ok: true as const });
});

// --- Members --------------------------------------------------------------------------------------

vaults.post(
  "/:id/members",
  validate("param", idParamsSchema),
  validate("json", inviteMemberRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const now = Date.now();
    const { vault, member } = await getVaultAccess(db, id, user.id);
    requireRole(member.role, "manager");
    if (body.role === "manager" && member.role !== "owner") {
      throw forbidden("Only the owner can add managers.");
    }
    assertVaultWritable(vault, body.keyVersion);
    if (body.userId === user.id) throw conflict("You are already a member of this vault.");

    const target = await db
      .select({
        id: users.id,
        email: users.email,
        publicKey: users.publicKey,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, body.userId))
      .get();
    if (target?.status !== "active") throw notFound();

    const membershipId = newId();
    let rows: VaultMember[];
    try {
      // Guarded insert: only if the vault is still at this key version and not rotating.
      rows = await db
        .insert(vaultMembers)
        .select(
          db
            .select({
              id: sqlValue(membershipId, "id"),
              vaultId: vaultsTable.id,
              userId: sqlValue(target.id, "user_id"),
              role: sqlValue(body.role, "role"),
              keyVersion: sqlValue(body.keyVersion, "key_version"),
              sealedKey: sqlValue(body.sealedKey, "sealed_key"),
              status: sqlValue("pending" as const, "status"),
              invitedBy: sqlValue(user.id, "invited_by"),
              createdAt: sqlValue(now, "created_at"),
              updatedAt: sqlValue(now, "updated_at"),
            })
            .from(vaultsTable)
            .where(
              and(
                eq(vaultsTable.id, id),
                vaultAcceptsKeyVersion(db, vaultsTable.id, body.keyVersion),
              ),
            ),
        )
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("This user is already a member of the vault or has a pending invitation.");
      }
      throw err;
    }
    const created = rows[0];
    if (!created) return throwVaultWriteFailure(db, id, body.keyVersion);
    await audit(db, user.id, "share_created", { kind: "vault", vaultId: id, role: body.role }, now);
    return c.json({ member: toMemberWire(created, target, false) }, 201);
  },
);

vaults.patch(
  "/:id/members/:memberId",
  validate("param", vaultMemberParamsSchema),
  validate("json", updateMemberRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id, memberId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { member: me } = await getVaultAccess(db, id, user.id);
    requireRole(me.role, "manager");
    const target = await getMemberOfVault(db, id, memberId);

    if (target.member.role === "owner") throw forbidden("The owner's role cannot be changed.");
    if (me.role !== "owner" && (target.member.role === "manager" || body.role === "manager")) {
      throw forbidden("Only the owner can promote or demote managers.");
    }

    const [updated] = await db
      .update(vaultMembers)
      .set({ role: body.role, updatedAt: Date.now() })
      .where(and(eq(vaultMembers.id, memberId), eq(vaultMembers.vaultId, id)))
      .returning();
    if (!updated) throw notFound();
    return c.json({ member: toMemberWire(updated, target, updated.userId === user.id) });
  },
);

vaults.delete("/:id/members/:memberId", validate("param", vaultMemberParamsSchema), async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id, memberId } = c.req.valid("param");
  const now = Date.now();
  const { member: me } = await getVaultAccess(db, id, user.id);
  requireRole(me.role, "manager");
  const { member: target } = await getMemberOfVault(db, id, memberId);

  if (target.role === "owner") throw forbidden("The owner cannot be removed.");
  if (me.role !== "owner" && target.role === "manager") {
    throw forbidden("Only the owner can remove managers.");
  }
  if (target.userId === user.id) throw forbidden("Use leave to remove yourself.");

  await runBatch(db, [
    db
      .delete(vaultMembers)
      .where(
        and(
          eq(vaultMembers.id, memberId),
          eq(vaultMembers.vaultId, id),
          ne(vaultMembers.role, "owner"),
        ),
      ),
    // The removed member knows the vault key: the vault needs a rotation (PLAN.md 11.4).
    db
      .update(vaultsTable)
      .set({ rotationPending: true, updatedAt: now })
      .where(eq(vaultsTable.id, id)),
    // Their client drops the whole vault; everyone else just drops the member.
    tombstone(db, { entity: "vault", entityId: id, vaultId: id, userId: target.userId }, now),
    tombstone(db, { entity: "vault_member", entityId: memberId, vaultId: id, userId: null }, now),
    auditStatement(
      db,
      user.id,
      "share_revoked",
      { kind: "vault", vaultId: id, role: target.role, status: target.status },
      now,
    ),
  ]);
  return c.json({ ok: true as const, rotationPending: true });
});

vaults.post("/:id/leave", validate("param", idParamsSchema), emptyBody, async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const now = Date.now();
  const { member } = await getVaultAccess(db, id, user.id);
  if (member.role === "owner") {
    throw conflict("The owner cannot leave a vault. Delete the vault instead.");
  }
  await runBatch(db, [
    db.delete(vaultMembers).where(eq(vaultMembers.id, member.id)),
    tombstone(db, { entity: "vault", entityId: id, vaultId: id, userId: user.id }, now),
    tombstone(db, { entity: "vault_member", entityId: member.id, vaultId: id, userId: null }, now),
    auditStatement(db, user.id, "vault_left", { vaultId: id }, now),
  ]);
  return c.json({ ok: true as const });
});

// --- Key rotation ---------------------------------------------------------------------------------

vaults.post(
  "/:id/rotate",
  validate("param", idParamsSchema),
  validate("json", rotateVaultRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    const { user } = getAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const now = Date.now();
    const { vault, member } = await getVaultAccess(db, id, user.id);
    requireRole(member.role, "manager");

    if (body.step === "chunk") {
      const accepted = await stageRotationChunk(db, vault, body, now);
      return c.json({ step: "chunk" as const, accepted });
    }
    const updated = await finalizeRotation(db, vault, body, user.id, now);
    return c.json({ step: "finalize" as const, vault: toVaultWire(updated, member.role) });
  },
);
