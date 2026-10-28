import type { Handlers } from "../protocol.ts";
import type { HandlerOptions } from "../registry.ts";
import type { WorkerState } from "../state.ts";
import { applySyncResponse } from "../vault/apply-sync.ts";
import {
  createItemBody,
  createVaultBody,
  moveItemBody,
  updateItemBody,
  updateVaultMetaBody,
} from "../vault/item-ops.ts";
import {
  commitVaultRotation,
  discardVaultRotation,
  openPending,
  prepareItemKeyRotation,
  prepareVaultRotation,
  sealItemKey,
  sealVaultKey,
} from "../vault/sharing-ops.ts";
import { createExclusive, requireItem, VaultStore } from "../vault/store.ts";
import { buildItemView } from "../vault/views.ts";
import type { VaultOpMap } from "../vault-protocol.ts";

/**
 * Vault, item and sharing operations (PLAN.md sections 9, 11, 15). The store with the synced
 * records and decrypted caches lives here, in the worker; vault keys live in `state.vaultKeys`.
 * Everything is dropped when the worker locks. Ops run one at a time so a sync never interleaves
 * with a write.
 */
export function createVaultHandlers(
  state: WorkerState,
  _options: HandlerOptions = {},
): Handlers<VaultOpMap> {
  const store = new VaultStore();
  const exclusive = createExclusive();
  state.onLock(() => store.clear());

  return {
    applySync: ({ response }) => exclusive(() => applySyncResponse(state, store, response)),

    getItem: ({ id }) =>
      exclusive(async () => {
        const me = state.requireUnlocked();
        const item = requireItem(store, id);
        const view = buildItemView(store, me.userId, id);
        if (!view) throw new Error("unreachable");
        return {
          item: view,
          content: store.decrypted.get(id)?.content ?? null,
          itemKeyVersion: item.itemKeyVersion,
          vaultKeyVersion: item.vaultKeyVersion,
        };
      }),

    createItem: (args) =>
      exclusive(async () => ({ body: await createItemBody(state, store, args) })),
    updateItem: (args) =>
      exclusive(async () => ({ body: await updateItemBody(state, store, args) })),
    moveItem: (args) => exclusive(async () => ({ body: await moveItemBody(state, store, args) })),

    createVault: (args) => exclusive(() => createVaultBody(state, args)),
    updateVaultMeta: (args) =>
      exclusive(async () => ({ body: await updateVaultMetaBody(state, store, args) })),

    sealVaultKeyFor: (args) => exclusive(() => sealVaultKey(state, store, args)),
    sealItemKeyFor: (args) => exclusive(() => sealItemKey(state, store, args)),

    prepareRotation: (args) => exclusive(() => prepareVaultRotation(state, store, args)),
    commitRotation: (args) =>
      exclusive(async () => {
        commitVaultRotation(state, store, args);
      }),
    discardRotation: (args) =>
      exclusive(async () => {
        discardVaultRotation(store, args);
      }),
    prepareItemKeyRotation: (args) =>
      exclusive(async () => ({ body: await prepareItemKeyRotation(state, store, args) })),

    openPendingShare: (args) => exclusive(() => openPending(state, args)),

    clearVaultState: () =>
      exclusive(async () => {
        store.clear();
      }),
  };
}
