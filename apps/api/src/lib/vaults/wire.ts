// Row -> wire mappers. Every mapper builds exactly the shape of the @pm/shared response schemas
// (they are strict objects, so extra keys would fail parsing).
import type {
  ItemShareWire,
  ItemWire,
  PendingItemShare,
  PendingVaultShare,
  VaultMemberWire,
  VaultWire,
} from "@pm/shared";
import type { Item, ItemShare, Vault, VaultMember, VaultMemberRole } from "../../db/schema.ts";

export function toVaultWire(vault: Vault, myRole: VaultMemberRole): VaultWire {
  return {
    id: vault.id,
    ownerId: vault.ownerId,
    keyVersion: vault.keyVersion,
    encryptedMeta: vault.encryptedMeta,
    rotationPending: vault.rotationPending,
    myRole,
    createdAt: vault.createdAt,
    updatedAt: vault.updatedAt,
  };
}

/** `sealedKey` is included only when `isMine` (the vault key sealed to the requester). */
export function toMemberWire(
  member: VaultMember,
  user: { email: string; publicKey: string },
  isMine: boolean,
): VaultMemberWire {
  const wire: VaultMemberWire = {
    id: member.id,
    vaultId: member.vaultId,
    userId: member.userId,
    email: user.email,
    publicKey: user.publicKey,
    role: member.role,
    status: member.status,
    keyVersion: member.keyVersion,
    invitedBy: member.invitedBy,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
  if (isMine) wire.sealedKey = member.sealedKey;
  return wire;
}

export function toItemWire(item: Item): ItemWire {
  return {
    id: item.id,
    vaultId: item.vaultId,
    itemKeyVersion: item.itemKeyVersion,
    wrappedKey: item.wrappedKey,
    vaultKeyVersion: item.vaultKeyVersion,
    encryptedData: item.encryptedData,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    trashedAt: item.trashedAt,
    createdBy: item.createdBy,
    updatedBy: item.updatedBy,
  };
}

/** `invitedBy` is null when the inviter's account has been deleted. */
export function toItemShareWire(
  share: ItemShare,
  context: { vaultId: string; email: string; publicKey: string },
  isMine: boolean,
): ItemShareWire {
  const wire: ItemShareWire = {
    id: share.id,
    itemId: share.itemId,
    vaultId: context.vaultId,
    userId: share.userId,
    email: context.email,
    publicKey: context.publicKey,
    role: share.role,
    status: share.status,
    keyVersion: share.keyVersion,
    invitedBy: share.invitedBy,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
  if (isMine) wire.sealedKey = share.sealedKey;
  return wire;
}

export function toPendingVaultShare(
  member: VaultMember,
  vault: Pick<Vault, "encryptedMeta">,
  inviter: { id: string; email: string },
): PendingVaultShare | null {
  // Ownership is never granted by invite, so a pending row cannot be an owner row.
  if (member.role === "owner") return null;
  return {
    kind: "vault",
    id: member.id,
    vaultId: member.vaultId,
    role: member.role,
    keyVersion: member.keyVersion,
    sealedKey: member.sealedKey,
    encryptedMeta: vault.encryptedMeta,
    invitedBy: inviter.id,
    invitedByEmail: inviter.email,
    createdAt: member.createdAt,
  };
}

export function toPendingItemShare(
  share: ItemShare,
  item: Pick<Item, "vaultId">,
  inviter: { id: string; email: string },
): PendingItemShare {
  return {
    kind: "item",
    id: share.id,
    itemId: share.itemId,
    vaultId: item.vaultId,
    role: share.role,
    keyVersion: share.keyVersion,
    sealedKey: share.sealedKey,
    invitedBy: inviter.id,
    invitedByEmail: inviter.email,
    createdAt: share.createdAt,
  };
}
