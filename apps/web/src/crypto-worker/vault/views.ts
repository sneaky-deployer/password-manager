import type {
  ItemListView,
  ItemShareView,
  MemberView,
  VaultSnapshot,
  VaultView,
} from "../vault-protocol.ts";
import { roleAtLeast, type VaultStore } from "./store.ts";

export const UNREADABLE_ITEM_NAME = "Unreadable item";
export const UNREADABLE_VAULT_NAME = "Unreadable vault";

/** My single-item share on `itemId`, when the item reaches me through one. */
export function myShare(store: VaultStore, userId: string, itemId: string) {
  for (const share of store.itemShares.values()) {
    if (share.itemId === itemId && share.userId === userId && share.status === "active") {
      return share;
    }
  }
  return undefined;
}

export function buildVaultView(store: VaultStore, vaultId: string): VaultView | null {
  const vault = store.vaults.get(vaultId);
  if (!vault) return null;
  const meta = store.metas.get(vaultId)?.meta ?? null;
  const members = store.membersOf(vaultId);
  const view: VaultView = {
    id: vault.id,
    name: meta?.name ?? UNREADABLE_VAULT_NAME,
    readable: meta !== null,
    myRole: vault.myRole,
    keyVersion: vault.keyVersion,
    rotationPending: vault.rotationPending,
    isOwner: vault.myRole === "owner",
    memberCount: members.filter((member) => member.status === "active").length,
    pendingMemberCount: members.filter((member) => member.status === "pending").length,
    createdAt: vault.createdAt,
    updatedAt: vault.updatedAt,
  };
  if (meta?.icon !== undefined) view.icon = meta.icon;
  if (meta?.color !== undefined) view.color = meta.color;
  return view;
}

export function buildItemView(
  store: VaultStore,
  userId: string,
  itemId: string,
): ItemListView | null {
  const item = store.items.get(itemId);
  if (!item) return null;
  const content = store.decrypted.get(itemId)?.content ?? null;
  const vault = store.vaults.get(item.vaultId);
  const share = vault ? undefined : myShare(store, userId, itemId);

  const canEdit = vault ? roleAtLeast(vault.myRole, "editor") : share?.role === "editor";
  const view: ItemListView = {
    id: item.id,
    vaultId: item.vaultId,
    type: content ? content.type : "unknown",
    name: content ? content.name : UNREADABLE_ITEM_NAME,
    urls: content?.type === "login" ? content.urls : [],
    hasTotp: content?.type === "login" && Boolean(content.totp),
    hasPassword: content?.type === "login" && Boolean(content.password),
    trashed: item.trashedAt !== null,
    trashedAt: item.trashedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revision: item.revision,
    sharedWithMe: !vault,
    readable: content !== null,
    canEdit: Boolean(canEdit),
    canManage: vault ? roleAtLeast(vault.myRole, "editor") : false,
    canShare: vault ? roleAtLeast(vault.myRole, "manager") : false,
    shareCount: store.sharesOf(itemId).length,
  };
  if (content?.type === "login" && content.username) view.username = content.username;
  return view;
}

export function buildMemberView(
  member: ReturnType<VaultStore["membersOf"]>[number],
  userId: string,
): MemberView {
  return {
    id: member.id,
    vaultId: member.vaultId,
    userId: member.userId,
    email: member.email,
    role: member.role,
    status: member.status,
    isMe: member.userId === userId,
    createdAt: member.createdAt,
  };
}

export function buildItemShareView(
  share: ReturnType<VaultStore["sharesOf"]>[number],
  userId: string,
): ItemShareView {
  return {
    id: share.id,
    itemId: share.itemId,
    vaultId: share.vaultId,
    userId: share.userId,
    email: share.email,
    role: share.role,
    status: share.status,
    isMe: share.userId === userId,
  };
}

/** The complete list-safe state. Never contains secrets, keys or ciphertext. */
export function buildSnapshot(store: VaultStore, userId: string): VaultSnapshot {
  const vaults: VaultView[] = [];
  for (const id of store.vaults.keys()) {
    const view = buildVaultView(store, id);
    if (view) vaults.push(view);
  }
  const items: ItemListView[] = [];
  for (const id of store.items.keys()) {
    const view = buildItemView(store, userId, id);
    if (view) items.push(view);
  }
  return {
    vaults,
    items,
    members: [...store.members.values()].map((member) => buildMemberView(member, userId)),
    itemShares: [...store.itemShares.values()].map((share) => buildItemShareView(share, userId)),
  };
}
