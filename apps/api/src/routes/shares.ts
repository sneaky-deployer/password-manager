// Pending invitations for the signed-in user and accept / decline (PLAN.md 11.2, 11.3).
//
// `:id` of accept / decline is a vault membership id or an item share id (server-generated UUIDs,
// looked up in both tables, always restricted to rows addressed to the requester). Only `pending`
// rows can be answered: declining deletes the row (and tells the vault members through a
// tombstone, because managers see pending invitees in the member list); accepting an already
// active row is an idempotent success; anything else is 404.
//
// Accepting is refused with 409 `key_version_mismatch` if the sealed key is not for the vault's
// (or item's) current key version. Rotation re-seals pending members' keys too, so this only
// guards against a bug or a race.
import { idParamsSchema } from "@pm/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import { itemShares, items, users, vaultMembers, vaults } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { auditStatement } from "../lib/audit.ts";
import { validate } from "../lib/validate.ts";
import { returnedRows, runBatch } from "../lib/vaults/db.ts";
import { keyVersionMismatch, notFound } from "../lib/vaults/errors.ts";
import { emptyBody } from "../lib/vaults/http.ts";
import { tombstone } from "../lib/vaults/tombstones.ts";
import { toPendingItemShare, toPendingVaultShare } from "../lib/vaults/wire.ts";
import { getAuth, requireAuth } from "../middleware/session.ts";

// D1 NOTE: selects run inside `db.batch()` come back as objects keyed by column name, so two
// selected columns with the same SQL name (users.id next to vault_members.id) collapse into one.
// Every batched select below aliases such columns with `.as(...)`.
export const shares = new Hono<AppEnv>();

shares.use(requireAuth);

shares.get("/pending", async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  // Invitations whose inviter's account is gone are not listed: the shared schema requires the
  // inviter's id and email, and nobody can vouch for such an invitation anymore.
  const [vaultRows, itemRows] = (await runBatch(db, [
    db
      .select({
        member: vaultMembers,
        encryptedMeta: vaults.encryptedMeta,
        inviterId: sql<string>`${users.id}`.as("inviter_id"),
        inviterEmail: users.email,
      })
      .from(vaultMembers)
      .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
      .innerJoin(users, eq(users.id, vaultMembers.invitedBy))
      .where(and(eq(vaultMembers.userId, user.id), eq(vaultMembers.status, "pending")))
      .orderBy(desc(vaultMembers.createdAt)),
    db
      .select({
        share: itemShares,
        vaultId: items.vaultId,
        inviterId: sql<string>`${users.id}`.as("inviter_id"),
        inviterEmail: users.email,
      })
      .from(itemShares)
      .innerJoin(items, eq(items.id, itemShares.itemId))
      .innerJoin(users, eq(users.id, itemShares.invitedBy))
      .where(and(eq(itemShares.userId, user.id), eq(itemShares.status, "pending")))
      .orderBy(desc(itemShares.createdAt)),
  ])) as [
    {
      member: typeof vaultMembers.$inferSelect;
      encryptedMeta: string;
      inviterId: string;
      inviterEmail: string;
    }[],
    {
      share: typeof itemShares.$inferSelect;
      vaultId: string;
      inviterId: string;
      inviterEmail: string;
    }[],
  ];

  const pending = [
    ...vaultRows.flatMap((row) => {
      const wire = toPendingVaultShare(row.member, row, {
        id: row.inviterId,
        email: row.inviterEmail,
      });
      return wire ? [wire] : [];
    }),
    ...itemRows.map((row) =>
      toPendingItemShare(row.share, row, { id: row.inviterId, email: row.inviterEmail }),
    ),
  ].sort((a, b) => b.createdAt - a.createdAt);
  return c.json({ shares: pending });
});

/** My membership or item share with this id (whichever table holds it), with its target's key version. */
async function findOwnInvitation(db: ReturnType<typeof getDb>, id: string, userId: string) {
  const [memberRows, shareRows] = (await runBatch(db, [
    db
      .select({
        id: vaultMembers.id,
        vaultId: vaultMembers.vaultId,
        status: vaultMembers.status,
        keyVersion: vaultMembers.keyVersion,
        currentKeyVersion: sql<number>`${vaults.keyVersion}`.as("current_key_version"),
      })
      .from(vaultMembers)
      .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
      .where(and(eq(vaultMembers.id, id), eq(vaultMembers.userId, userId))),
    db
      .select({
        id: itemShares.id,
        itemId: itemShares.itemId,
        vaultId: items.vaultId,
        status: itemShares.status,
        keyVersion: itemShares.keyVersion,
        currentKeyVersion: sql<number>`${items.itemKeyVersion}`.as("current_key_version"),
      })
      .from(itemShares)
      .innerJoin(items, eq(items.id, itemShares.itemId))
      .where(and(eq(itemShares.id, id), eq(itemShares.userId, userId))),
  ])) as [
    {
      id: string;
      vaultId: string;
      status: "pending" | "active";
      keyVersion: number;
      currentKeyVersion: number;
    }[],
    {
      id: string;
      itemId: string;
      vaultId: string;
      status: "pending" | "active";
      keyVersion: number;
      currentKeyVersion: number;
    }[],
  ];
  const member = memberRows[0];
  if (member) return { kind: "vault" as const, ...member };
  const share = shareRows[0];
  if (share) return { kind: "item" as const, ...share };
  throw notFound();
}

shares.post("/:id/accept", validate("param", idParamsSchema), emptyBody, async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const now = Date.now();
  const invitation = await findOwnInvitation(db, id, user.id);
  if (invitation.status === "active") return c.json({ ok: true as const });
  if (invitation.keyVersion !== invitation.currentKeyVersion) {
    throw keyVersionMismatch({ currentKeyVersion: invitation.currentKeyVersion });
  }

  const results =
    invitation.kind === "vault"
      ? await runBatch(db, [
          db
            .update(vaultMembers)
            .set({ status: "active", updatedAt: now })
            .where(
              and(
                eq(vaultMembers.id, id),
                eq(vaultMembers.userId, user.id),
                eq(vaultMembers.status, "pending"),
              ),
            )
            .returning({ id: vaultMembers.id }),
          auditStatement(
            db,
            user.id,
            "share_accepted",
            { kind: "vault", vaultId: invitation.vaultId },
            now,
          ),
        ])
      : await runBatch(db, [
          db
            .update(itemShares)
            .set({ status: "active", updatedAt: now })
            .where(
              and(
                eq(itemShares.id, id),
                eq(itemShares.userId, user.id),
                eq(itemShares.status, "pending"),
              ),
            )
            .returning({ id: itemShares.id }),
          auditStatement(
            db,
            user.id,
            "share_accepted",
            { kind: "item", itemId: invitation.itemId },
            now,
          ),
        ]);
  if (returnedRows(results[0]).length === 0) throw notFound();
  return c.json({ ok: true as const });
});

shares.post("/:id/decline", validate("param", idParamsSchema), emptyBody, async (c) => {
  const db = getDb(c.env);
  const { user } = getAuth(c);
  const { id } = c.req.valid("param");
  const now = Date.now();
  const invitation = await findOwnInvitation(db, id, user.id);
  // Active memberships are left with `POST /vaults/:id/leave`, not declined.
  if (invitation.status !== "pending") throw notFound();

  const results =
    invitation.kind === "vault"
      ? await runBatch(db, [
          db
            .delete(vaultMembers)
            .where(
              and(
                eq(vaultMembers.id, id),
                eq(vaultMembers.userId, user.id),
                eq(vaultMembers.status, "pending"),
              ),
            )
            .returning({ id: vaultMembers.id }),
          // Managers listed the pending invitee: tell the vault's members it is gone.
          tombstone(
            db,
            { entity: "vault_member", entityId: id, vaultId: invitation.vaultId, userId: null },
            now,
          ),
          auditStatement(
            db,
            user.id,
            "share_declined",
            { kind: "vault", vaultId: invitation.vaultId },
            now,
          ),
        ])
      : await runBatch(db, [
          db
            .delete(itemShares)
            .where(
              and(
                eq(itemShares.id, id),
                eq(itemShares.userId, user.id),
                eq(itemShares.status, "pending"),
              ),
            )
            .returning({ id: itemShares.id }),
          tombstone(
            db,
            { entity: "item_share", entityId: id, vaultId: invitation.vaultId, userId: null },
            now,
          ),
          auditStatement(
            db,
            user.id,
            "share_declined",
            { kind: "item", itemId: invitation.itemId },
            now,
          ),
        ]);
  if (returnedRows(results[0]).length === 0) throw notFound();
  return c.json({ ok: true as const });
});
