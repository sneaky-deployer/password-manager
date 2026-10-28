// Who may do what (PLAN.md 11.1). The server never decrypts anything; these checks decide who may
// read ciphertext and who may upload it.
//
// Roles, increasing power: viewer < editor < manager < owner.
// - Non-members (and members whose membership is still `pending`) get 404 on everything in a
//   vault, so a vault's existence is not revealed. Members with too low a role get 403.
// - viewer: read. editor: + create/edit/trash/restore/delete/move items.
// - manager: + invite members (viewer/editor only), change viewer/editor roles, remove
//   viewers/editors, share single items. owner: + manager changes, remove managers, rotate, delete.
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type Item,
  type ItemShareRole,
  itemShares,
  items,
  type Vault,
  type VaultMember,
  type VaultMemberRole,
  vaultMembers,
  vaults,
} from "../../db/schema.ts";
import { forbidden, notFound } from "./errors.ts";

const RANK: Record<VaultMemberRole, number> = { viewer: 0, editor: 1, manager: 2, owner: 3 };

export function hasRole(role: VaultMemberRole, minimum: VaultMemberRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Throws 403 unless `role` is at least `minimum`. */
export function requireRole(role: VaultMemberRole, minimum: VaultMemberRole, message?: string) {
  if (!hasRole(role, minimum)) throw forbidden(message);
}

export interface VaultAccess {
  vault: Vault;
  /** The requester's own (active) membership. */
  member: VaultMember;
}

/** The vault and my active membership, or 404 (non-member, pending member, unknown vault). */
export async function getVaultAccess(db: Db, vaultId: string, userId: string) {
  const row = await db
    .select({ vault: vaults, member: vaultMembers })
    .from(vaultMembers)
    .innerJoin(vaults, eq(vaults.id, vaultMembers.vaultId))
    .where(
      and(
        eq(vaultMembers.vaultId, vaultId),
        eq(vaultMembers.userId, userId),
        eq(vaultMembers.status, "active"),
      ),
    )
    .get();
  if (!row) throw notFound();
  return row satisfies VaultAccess;
}

export interface ItemAccess {
  item: Item;
  vault: Vault;
  /** My active role in the item's vault, or null when I only have an item share. */
  memberRole: VaultMemberRole | null;
  /** My active item-share role, or null. */
  shareRole: ItemShareRole | null;
}

/** The item with my access to it, or 404 when I have neither a vault membership nor a share. */
export async function getItemAccess(db: Db, itemId: string, userId: string): Promise<ItemAccess> {
  const row = await db
    .select({
      item: items,
      vault: vaults,
      memberRole: vaultMembers.role,
      shareRole: itemShares.role,
    })
    .from(items)
    .innerJoin(vaults, eq(vaults.id, items.vaultId))
    .leftJoin(
      vaultMembers,
      and(
        eq(vaultMembers.vaultId, items.vaultId),
        eq(vaultMembers.userId, userId),
        eq(vaultMembers.status, "active"),
      ),
    )
    .leftJoin(
      itemShares,
      and(
        eq(itemShares.itemId, items.id),
        eq(itemShares.userId, userId),
        eq(itemShares.status, "active"),
      ),
    )
    .where(eq(items.id, itemId))
    .get();
  if (!row || (!row.memberRole && !row.shareRole)) throw notFound();
  return row;
}

/** Item operations that only vault members may do (not single-item share recipients). */
export function requireMemberRole(access: ItemAccess, minimum: VaultMemberRole): VaultMemberRole {
  if (!access.memberRole || !hasRole(access.memberRole, minimum)) throw forbidden();
  return access.memberRole;
}
