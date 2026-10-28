import {
  apiPaths,
  createItemResponseSchema,
  createVaultResponseSchema,
  deleteItemResponseSchema,
  deleteVaultResponseSchema,
  type ItemContentInput,
  leaveVaultResponseSchema,
  moveItemResponseSchema,
  restoreItemResponseSchema,
  trashItemResponseSchema,
  updateItemResponseSchema,
  updateVaultResponseSchema,
  type VaultMeta,
} from "@pm/shared";
import type { QueryClient } from "@tanstack/react-query";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api } from "../../lib/api.ts";
import { shouldResync } from "./errors.ts";
import { syncNow } from "./sync.ts";

/**
 * Writes: ask the worker for the encrypted request body, send it, then sync so the list and the
 * worker's store reflect the result. A stale-key style failure triggers a sync as well, so the
 * next attempt starts from the server's truth.
 */
async function write<T>(queryClient: QueryClient, run: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    if (shouldResync(error)) void syncNow(queryClient).catch(() => undefined);
    throw error;
  }
  await syncNow(queryClient);
  return result;
}

export function createItemAction(
  queryClient: QueryClient,
  args: { vaultId: string; content: ItemContentInput },
): Promise<string> {
  return write(queryClient, async () => {
    const { body } = await cryptoClient.call("createItem", args);
    await api.post(apiPaths.items.root, { body, schema: createItemResponseSchema });
    return body.id;
  });
}

export function updateItemAction(
  queryClient: QueryClient,
  args: { id: string; content: ItemContentInput; revision: number },
): Promise<void> {
  return write(queryClient, async () => {
    const { body } = await cryptoClient.call("updateItem", args);
    await api.put(apiPaths.items.item(args.id), { body, schema: updateItemResponseSchema });
  });
}

export function moveItemAction(
  queryClient: QueryClient,
  args: { id: string; targetVaultId: string },
): Promise<void> {
  return write(queryClient, async () => {
    const { body } = await cryptoClient.call("moveItem", args);
    await api.post(apiPaths.items.move(args.id), { body, schema: moveItemResponseSchema });
  });
}

export function trashItemAction(queryClient: QueryClient, id: string): Promise<void> {
  return write(queryClient, async () => {
    await api.post(apiPaths.items.trash(id), { schema: trashItemResponseSchema });
  });
}

export function restoreItemAction(queryClient: QueryClient, id: string): Promise<void> {
  return write(queryClient, async () => {
    await api.post(apiPaths.items.restore(id), { schema: restoreItemResponseSchema });
  });
}

export function deleteItemAction(queryClient: QueryClient, id: string): Promise<void> {
  return write(queryClient, async () => {
    await api.delete(apiPaths.items.item(id), { schema: deleteItemResponseSchema });
  });
}

/** Permanently delete several trashed items one after the other. Returns how many failed. */
export async function emptyTrashAction(queryClient: QueryClient, ids: string[]): Promise<number> {
  let failed = 0;
  for (const id of ids) {
    try {
      await api.delete(apiPaths.items.item(id), { schema: deleteItemResponseSchema });
    } catch {
      failed += 1;
    }
  }
  await syncNow(queryClient);
  return failed;
}

export function createVaultAction(queryClient: QueryClient, meta: VaultMeta): Promise<string> {
  return write(queryClient, async () => {
    const { vaultId, body } = await cryptoClient.call("createVault", { meta });
    await api.post(apiPaths.vaults.root, { body, schema: createVaultResponseSchema });
    return vaultId;
  });
}

export function renameVaultAction(
  queryClient: QueryClient,
  args: { vaultId: string; meta: VaultMeta },
): Promise<void> {
  return write(queryClient, async () => {
    const { body } = await cryptoClient.call("updateVaultMeta", args);
    await api.patch(apiPaths.vaults.vault(args.vaultId), {
      body,
      schema: updateVaultResponseSchema,
    });
  });
}

export function deleteVaultAction(queryClient: QueryClient, vaultId: string): Promise<void> {
  return write(queryClient, async () => {
    await api.delete(apiPaths.vaults.vault(vaultId), { schema: deleteVaultResponseSchema });
  });
}

export function leaveVaultAction(queryClient: QueryClient, vaultId: string): Promise<void> {
  return write(queryClient, async () => {
    await api.post(apiPaths.vaults.leave(vaultId), { schema: leaveVaultResponseSchema });
  });
}
