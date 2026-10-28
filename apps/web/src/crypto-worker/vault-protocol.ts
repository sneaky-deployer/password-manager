import type {
  CreateItemRequest,
  CreateVaultRequest,
  ItemContent,
  ItemContentInput,
  ItemShareRole,
  MoveItemRequest,
  PendingShare,
  RotateVaultChunkRequest,
  RotateVaultFinalizeRequest,
  ShareStatus,
  SyncResponse,
  UpdateItemRequest,
  UpdateVaultRequest,
  VaultMeta,
  VaultRole,
} from "@pm/shared";
import type { Op } from "./protocol.ts";

/**
 * Vault, item and share operations of the crypto worker (PLAN.md sections 9, 11, 15).
 *
 * The UI calls them with `cryptoClient.call("opName", args)`. Rules: arguments and results are
 * structured-cloneable, and a result never contains a key (account key, private key, vault key,
 * item key). Decrypted content only leaves the worker through `getItem` (one item, on demand)
 * and the list-safe view models below.
 */

/** A vault as shown in the UI. Names come from the decrypted metadata. */
export type VaultView = {
  id: string;
  /** "Unreadable vault" when the metadata cannot be decrypted or validated. */
  name: string;
  icon?: string;
  color?: string;
  readable: boolean;
  myRole: VaultRole;
  keyVersion: number;
  rotationPending: boolean;
  isOwner: boolean;
  /** Active members, the owner included. */
  memberCount: number;
  /** Members who were invited but have not accepted yet. */
  pendingMemberCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ItemViewType = "login" | "note" | "unknown";

/** Everything the list needs. No passwords, TOTP secrets, notes or custom fields. */
export type ItemListView = {
  id: string;
  vaultId: string;
  type: ItemViewType;
  /** "Unreadable item" when it cannot be decrypted or validated. */
  name: string;
  username?: string;
  urls: string[];
  hasTotp: boolean;
  hasPassword: boolean;
  trashed: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  /** True when the item reaches me through a single-item share, not through a vault. */
  sharedWithMe: boolean;
  /** False when decryption or validation failed. */
  readable: boolean;
  /** Edit the content: editor+ member, or an `editor` item share. */
  canEdit: boolean;
  /** Trash, restore, delete and move: editor+ vault member (not item-share recipients). */
  canManage: boolean;
  /** Share the item or revoke item shares: manager+ vault member. */
  canShare: boolean;
  /** Number of single-item shares on it (any status). */
  shareCount: number;
};

export type MemberView = {
  id: string;
  vaultId: string;
  userId: string;
  email: string;
  role: VaultRole;
  status: ShareStatus;
  isMe: boolean;
  createdAt: number;
};

export type ItemShareView = {
  id: string;
  itemId: string;
  vaultId: string;
  userId: string;
  email: string;
  role: ItemShareRole;
  status: ShareStatus;
  isMe: boolean;
};

/** Complete decrypted-safe state after applying a sync response. */
export type VaultSnapshot = {
  vaults: VaultView[];
  items: ItemListView[];
  members: MemberView[];
  itemShares: ItemShareView[];
};

export type ItemDetailView = {
  item: ItemListView;
  /** Null when the item is unreadable. */
  content: ItemContent | null;
  itemKeyVersion: number;
  vaultKeyVersion: number;
};

export type PendingShareView =
  | { kind: "vault"; id: string; readable: boolean; name: string; icon?: string; color?: string }
  | { kind: "item"; id: string; readable: boolean };

export type PreparedRotation = {
  vaultId: string;
  newKeyVersion: number;
  /** Upload in order with `POST /vaults/:id/rotate`, then `finalize`. */
  chunks: RotateVaultChunkRequest[];
  finalize: RotateVaultFinalizeRequest;
};

/** Stable error codes of the vault ops (next to `CRYPTO_ERROR` in `protocol.ts`). */
export const VAULT_ERROR = {
  vaultNotFound: "vault_not_found",
  itemNotFound: "item_not_found",
  /** The vault key (or item key) for the needed version is not in the worker. Sync, then retry. */
  keyMissing: "vault_key_missing",
  /** My role does not allow the operation. */
  notAllowed: "vault_not_allowed",
  invalidContent: "invalid_item_content",
  noPendingRotation: "no_pending_rotation",
  /** An item cannot be decrypted, so the vault cannot be rotated until it is deleted. */
  rotationItemUnreadable: "rotation_item_unreadable",
} as const;

export type VaultOpMap = {
  /**
   * Apply a `GET /sync` response: tombstones first, then upserts, idempotently (the server
   * re-sends a 2 s overlap). `full: true` resets the store. Returns the complete current state.
   */
  applySync: Op<{ response: SyncResponse }, VaultSnapshot>;
  /** Decrypted content of one item (only called when the user opens it). */
  getItem: Op<{ id: string }, ItemDetailView>;

  /** Body for `POST /items` (new uuid, item key v1, wrapped under the vault's current key). */
  createItem: Op<{ vaultId: string; content: ItemContentInput }, { body: CreateItemRequest }>;
  /**
   * Body for `PUT /items/:id`. `revision` is the revision the editor was based on (defaults to
   * the revision in the store). Item-share recipients resend the key fields unchanged.
   */
  updateItem: Op<
    { id: string; content: ItemContentInput; revision?: number },
    { body: UpdateItemRequest }
  >;
  /** Body for `POST /items/:id/move`: the item key re-wrapped under the target vault key. */
  moveItem: Op<{ id: string; targetVaultId: string }, { body: MoveItemRequest }>;

  /** Body for `POST /vaults`: new vault key sealed to me, metadata encrypted under it. */
  createVault: Op<{ meta: VaultMeta }, { vaultId: string; body: CreateVaultRequest }>;
  /** Body for `PATCH /vaults/:id`. */
  updateVaultMeta: Op<{ vaultId: string; meta: VaultMeta }, { body: UpdateVaultRequest }>;

  /** The current vault key sealed for `publicKey` (for `POST /vaults/:id/members`). */
  sealVaultKeyFor: Op<
    { vaultId: string; publicKey: string },
    { keyVersion: number; sealedKey: string }
  >;
  /** The current item key sealed for `publicKey` (for `POST /items/:id/shares`). */
  sealItemKeyFor: Op<
    { itemId: string; publicKey: string },
    { keyVersion: number; sealedKey: string }
  >;

  /**
   * Re-encrypt the whole vault under a new vault key (PLAN.md 11.4). Uses the members and item
   * shares from the last sync. The new key stays pending in the worker until `commitRotation`.
   */
  prepareRotation: Op<{ vaultId: string }, PreparedRotation>;
  /** The server accepted `finalize`: adopt the new vault key locally. */
  commitRotation: Op<{ vaultId: string }, void>;
  /** Drop a prepared rotation (failed or abandoned upload). */
  discardRotation: Op<{ vaultId: string }, void>;
  /**
   * After revoking an item share: a `PUT /items/:id` body with a new item key version and
   * re-sealed `shareKeys` for the remaining shares (everything except `removedShareId`).
   */
  prepareItemKeyRotation: Op<
    { itemId: string; removedShareId: string },
    { body: UpdateItemRequest }
  >;

  /** Decrypt the name of a pending invitation before it is accepted. */
  openPendingShare: Op<{ pending: PendingShare }, PendingShareView>;

  /** Drop every decrypted cache and key held by the vault store (also done on lock). */
  clearVaultState: Op<undefined, void>;
};
