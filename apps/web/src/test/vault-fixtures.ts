import type { ItemContent, PendingShare } from "@pm/shared";
import type {
  ItemDetailView,
  ItemListView,
  ItemShareView,
  MemberView,
  PendingShareView,
  VaultSnapshot,
  VaultView,
} from "../crypto-worker/vault-protocol.ts";
import { cryptoCall } from "./fake-crypto.ts";
import { ENVELOPE, KEY32, OTHER_ID, USER_ID } from "./fixtures.ts";

export const VAULT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const VAULT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ITEM_1 = "10000000-0000-4000-8000-000000000001";
export const ITEM_2 = "10000000-0000-4000-8000-000000000002";
export const ITEM_3 = "10000000-0000-4000-8000-000000000003";
export const ITEM_4 = "10000000-0000-4000-8000-000000000004";

export function vaultView(overrides: Partial<VaultView> = {}): VaultView {
  return {
    id: VAULT_A,
    name: "Personal",
    color: "violet",
    readable: true,
    myRole: "owner",
    keyVersion: 1,
    rotationPending: false,
    isOwner: true,
    memberCount: 1,
    pendingMemberCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function itemView(overrides: Partial<ItemListView> = {}): ItemListView {
  return {
    id: ITEM_1,
    vaultId: VAULT_A,
    type: "login",
    name: "GitHub",
    username: "alice@example.com",
    urls: ["https://github.com"],
    hasTotp: false,
    hasPassword: true,
    trashed: false,
    trashedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    revision: 1,
    sharedWithMe: false,
    readable: true,
    canEdit: true,
    canManage: true,
    canShare: true,
    shareCount: 0,
    ...overrides,
  };
}

export function loginContent(overrides: Partial<Extract<ItemContent, { type: "login" }>> = {}) {
  return {
    type: "login",
    name: "GitHub",
    username: "alice@example.com",
    password: "s3cret-pass",
    urls: ["https://github.com"],
    customFields: [],
    ...overrides,
  } satisfies ItemContent;
}

export function memberView(overrides: Partial<MemberView> = {}): MemberView {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    vaultId: VAULT_A,
    userId: USER_ID,
    email: "alice@example.com",
    role: "owner",
    status: "active",
    isMe: true,
    createdAt: 1,
    ...overrides,
  };
}

/** A schema-valid `ItemWire` for mocked item endpoints. */
export function itemWire(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_1,
    vaultId: VAULT_A,
    itemKeyVersion: 1,
    wrappedKey: ENVELOPE,
    vaultKeyVersion: 1,
    encryptedData: ENVELOPE,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    trashedAt: null,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    ...overrides,
  };
}

/** A schema-valid `VaultWire` for mocked vault endpoints. */
export function vaultWire(overrides: Record<string, unknown> = {}) {
  return {
    id: VAULT_A,
    ownerId: USER_ID,
    keyVersion: 1,
    encryptedMeta: ENVELOPE,
    rotationPending: false,
    myRole: "owner",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** A schema-valid `VaultMemberWire`. */
export function memberWire(overrides: Record<string, unknown> = {}) {
  return {
    id: "20000000-0000-4000-8000-0000000000aa",
    vaultId: VAULT_A,
    userId: OTHER_ID,
    email: "carol@example.com",
    publicKey: KEY32,
    role: "editor",
    status: "pending",
    keyVersion: 1,
    invitedBy: USER_ID,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export const SEALED = "S".repeat(100);
export { ENVELOPE, KEY32 };

export const emptySyncResponse = (serverTime = 1000) => ({
  serverTime,
  full: true,
  vaults: [],
  members: [],
  items: [],
  itemShares: [],
  deletions: [],
});

export interface World {
  vaults: VaultView[];
  items: ItemListView[];
  members?: MemberView[];
  itemShares?: ItemShareView[];
  /** Decrypted content by item id. Missing ids are served as unreadable. */
  contents?: Record<string, ItemContent>;
  /** Extra per-op behaviour, tried before the defaults. Return `undefined` to fall through. */
  ops?: Record<string, (args: unknown) => unknown>;
}

/** Make the mocked crypto worker answer like the real one for a fixed world. */
export function mockVaultWorld(world: World) {
  const snapshot = (): VaultSnapshot => ({
    vaults: world.vaults,
    items: world.items,
    members: world.members ?? [],
    itemShares: world.itemShares ?? [],
  });
  cryptoCall.mockImplementation(async (op: string, args?: unknown) => {
    const custom = world.ops?.[op];
    if (custom) return custom(args);
    switch (op) {
      case "applySync":
        return snapshot();
      case "getItem": {
        const id = (args as { id: string }).id;
        const item = world.items.find((i) => i.id === id);
        if (!item) throw new Error("item_not_found");
        const content = world.contents?.[id] ?? null;
        return { item, content, itemKeyVersion: 1, vaultKeyVersion: 1 } satisfies ItemDetailView;
      }
      case "openPendingShare": {
        const pending = (args as { pending: PendingShare }).pending;
        return pending.kind === "vault"
          ? ({
              kind: "vault",
              id: pending.id,
              readable: true,
              name: "Family",
            } satisfies PendingShareView)
          : ({ kind: "item", id: pending.id, readable: true } satisfies PendingShareView);
      }
      default:
        return undefined;
    }
  });
}

export { OTHER_ID, USER_ID };
