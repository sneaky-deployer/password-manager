import {
  createEncryptedItem,
  encryptItem,
  encryptVaultMeta,
  generateKey,
  sealKey,
  unwrapItemKey,
  wipe,
  wrapItemKey,
} from "@pm/crypto";
import {
  type CreateItemRequest,
  type CreateVaultRequest,
  type ItemContent,
  type ItemContentInput,
  itemContentSchema,
  type MoveItemRequest,
  type UpdateItemRequest,
  type UpdateVaultRequest,
  type VaultMeta,
  vaultMetaSchema,
} from "@pm/shared";
import type { WorkerState } from "../state.ts";
import { VAULT_ERROR } from "../vault-protocol.ts";
import {
  requireItem,
  requireVault,
  requireVaultKey,
  roleAtLeast,
  type VaultStore,
  vaultError,
} from "./store.ts";
import { myShare } from "./views.ts";

function parseContent(input: unknown): ItemContent {
  const parsed = itemContentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw vaultError(
      VAULT_ERROR.invalidContent,
      issue ? `${issue.path.join(".") || "item"}: ${issue.message}` : "Invalid item",
    );
  }
  return parsed.data;
}

/** Stamp `passwordUpdatedAt` when the password is new or changed; keep it otherwise. */
function withPasswordTimestamp(content: ItemContent, previous: ItemContent | null): ItemContent {
  if (content.type !== "login") return content;
  const next = { ...content };
  const before = previous?.type === "login" ? previous : null;
  if (!next.password) {
    delete next.passwordUpdatedAt;
  } else if (!before || before.password !== next.password) {
    next.passwordUpdatedAt = Date.now();
  } else if (before.passwordUpdatedAt !== undefined) {
    next.passwordUpdatedAt = before.passwordUpdatedAt;
  } else {
    next.passwordUpdatedAt = Date.now();
  }
  return next;
}

export async function createItemBody(
  state: WorkerState,
  store: VaultStore,
  args: { vaultId: string; content: ItemContentInput },
): Promise<CreateItemRequest> {
  state.requireUnlocked();
  const vault = requireVault(store, args.vaultId);
  if (!roleAtLeast(vault.myRole, "editor")) {
    throw vaultError(VAULT_ERROR.notAllowed, "You can only read this vault");
  }
  const vk = requireVaultKey(state, vault.id, vault.keyVersion);
  const content = withPasswordTimestamp(parseContent(args.content), null);
  const id = crypto.randomUUID();
  const created = await createEncryptedItem({
    vk,
    vaultId: vault.id,
    vaultKeyVersion: vault.keyVersion,
    itemId: id,
    content,
  });
  wipe(created.ik);
  return created.wire;
}

/** The item key of an item, plus where it came from (needed to know how it may be re-wrapped). */
async function openItemKey(state: WorkerState, store: VaultStore, itemId: string) {
  const item = requireItem(store, itemId);
  const vault = store.vaults.get(item.vaultId);
  if (vault) {
    const vk = requireVaultKey(state, vault.id, item.vaultKeyVersion);
    const ik = await unwrapItemKey(vk, vault.id, item.id, item.vaultKeyVersion, item.wrappedKey);
    return { item, vault, ik };
  }
  const key = store.itemKeys.get(itemId)?.get(item.itemKeyVersion);
  if (!key) {
    throw vaultError(VAULT_ERROR.keyMissing, "The item key is not available. Sync and try again.");
  }
  return { item, vault: null, ik: new Uint8Array(key) };
}

export { openItemKey };

export async function updateItemBody(
  state: WorkerState,
  store: VaultStore,
  args: { id: string; content: ItemContentInput; revision?: number },
): Promise<UpdateItemRequest> {
  const me = state.requireUnlocked();
  const { item, vault, ik } = await openItemKey(state, store, args.id);
  try {
    const canEdit = vault
      ? roleAtLeast(vault.myRole, "editor")
      : myShare(store, me.userId, item.id)?.role === "editor";
    if (!canEdit) throw vaultError(VAULT_ERROR.notAllowed, "You can only read this item");
    const previous = store.decrypted.get(item.id)?.content ?? null;
    const content = withPasswordTimestamp(parseContent(args.content), previous);
    const encryptedData = await encryptItem(ik, item.id, item.itemKeyVersion, content);
    const revision = args.revision ?? item.revision;

    // Members re-wrap under the vault's current key if the item still sits under an older one;
    // share recipients cannot wrap, so they resend the key fields exactly as stored.
    if (vault && item.vaultKeyVersion !== vault.keyVersion) {
      const vk = requireVaultKey(state, vault.id, vault.keyVersion);
      const wrappedKey = await wrapItemKey(vk, vault.id, item.id, vault.keyVersion, ik);
      return {
        itemKeyVersion: item.itemKeyVersion,
        wrappedKey,
        vaultKeyVersion: vault.keyVersion,
        encryptedData,
        revision,
      };
    }
    return {
      itemKeyVersion: item.itemKeyVersion,
      wrappedKey: item.wrappedKey,
      vaultKeyVersion: item.vaultKeyVersion,
      encryptedData,
      revision,
    };
  } finally {
    wipe(ik);
  }
}

export async function moveItemBody(
  state: WorkerState,
  store: VaultStore,
  args: { id: string; targetVaultId: string },
): Promise<MoveItemRequest> {
  state.requireUnlocked();
  const { item, vault, ik } = await openItemKey(state, store, args.id);
  try {
    if (!vault || !roleAtLeast(vault.myRole, "editor")) {
      throw vaultError(VAULT_ERROR.notAllowed, "You cannot move this item");
    }
    const target = requireVault(store, args.targetVaultId);
    if (!roleAtLeast(target.myRole, "editor")) {
      throw vaultError(VAULT_ERROR.notAllowed, "You can only read the target vault");
    }
    const targetVk = requireVaultKey(state, target.id, target.keyVersion);
    const wrappedKey = await wrapItemKey(targetVk, target.id, item.id, target.keyVersion, ik);
    return {
      targetVaultId: target.id,
      wrappedKey,
      vaultKeyVersion: target.keyVersion,
      revision: item.revision,
    };
  } finally {
    wipe(ik);
  }
}

export async function createVaultBody(
  state: WorkerState,
  args: { meta: VaultMeta },
): Promise<{ vaultId: string; body: CreateVaultRequest }> {
  const me = state.requireUnlocked();
  const parsed = vaultMetaSchema.safeParse(args.meta);
  if (!parsed.success) {
    throw vaultError(VAULT_ERROR.invalidContent, parsed.error.issues[0]?.message ?? "Invalid name");
  }
  const vaultId = crypto.randomUUID();
  const vk = await generateKey();
  try {
    const encryptedMeta = await encryptVaultMeta(vk, vaultId, 1, parsed.data);
    const sealedKey = await sealKey(me.publicKey, {
      type: "vault",
      id: vaultId,
      keyVersion: 1,
      key: vk,
    });
    return { vaultId, body: { id: vaultId, keyVersion: 1, encryptedMeta, sealedKey } };
  } finally {
    wipe(vk);
  }
}

export async function updateVaultMetaBody(
  state: WorkerState,
  store: VaultStore,
  args: { vaultId: string; meta: VaultMeta },
): Promise<UpdateVaultRequest> {
  state.requireUnlocked();
  const vault = requireVault(store, args.vaultId);
  if (!roleAtLeast(vault.myRole, "manager")) {
    throw vaultError(VAULT_ERROR.notAllowed, "Only managers can rename a vault");
  }
  const parsed = vaultMetaSchema.safeParse(args.meta);
  if (!parsed.success) {
    throw vaultError(VAULT_ERROR.invalidContent, parsed.error.issues[0]?.message ?? "Invalid name");
  }
  const vk = requireVaultKey(state, vault.id, vault.keyVersion);
  const encryptedMeta = await encryptVaultMeta(vk, vault.id, vault.keyVersion, parsed.data);
  return { keyVersion: vault.keyVersion, encryptedMeta };
}
