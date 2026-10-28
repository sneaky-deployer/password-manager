import {
  apiPaths,
  revokeItemShareResponseSchema,
  rotateVaultResponseSchema,
  updateItemResponseSchema,
} from "@pm/shared";
import type { QueryClient } from "@tanstack/react-query";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api, isApiError } from "../../lib/api.ts";
import { syncNow } from "../vault/sync.ts";

export type RotationPhase = "syncing" | "preparing" | "uploading" | "finalizing" | "done";

export interface RotationProgress {
  phase: RotationPhase;
  uploaded: number;
  total: number;
}

/** Shown after any revoke (PLAN.md 11.4). */
export const REVOKE_NOTICE =
  "They no longer have access. If they viewed these passwords, consider changing them.";

/** The server saw a different state than the worker (a concurrent edit or member change). */
function isRestartable(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "revision_conflict" ||
      error.code === "conflict" ||
      error.code === "validation_error")
  );
}

async function attempt(
  queryClient: QueryClient,
  vaultId: string,
  report: (progress: RotationProgress) => void,
): Promise<void> {
  report({ phase: "syncing", uploaded: 0, total: 0 });
  await syncNow(queryClient);

  report({ phase: "preparing", uploaded: 0, total: 0 });
  const prepared = await cryptoClient.call("prepareRotation", { vaultId });
  const total = prepared.chunks.reduce((sum, chunk) => sum + chunk.items.length, 0);
  try {
    let uploaded = 0;
    report({ phase: "uploading", uploaded, total });
    for (const chunk of prepared.chunks) {
      await api.post(apiPaths.vaults.rotate(vaultId), {
        body: chunk,
        schema: rotateVaultResponseSchema,
      });
      uploaded += chunk.items.length;
      report({ phase: "uploading", uploaded, total });
    }
    report({ phase: "finalizing", uploaded, total });
    await api.post(apiPaths.vaults.rotate(vaultId), {
      body: prepared.finalize,
      schema: rotateVaultResponseSchema,
    });
  } catch (error) {
    await cryptoClient.call("discardRotation", { vaultId }).catch(() => undefined);
    throw error;
  }
  await cryptoClient.call("commitRotation", { vaultId });
  await syncNow(queryClient);
  report({ phase: "done", uploaded: total, total });
}

/**
 * Rotate the vault key after a member was removed: sync, re-encrypt everything in the worker,
 * upload the chunks, finalize, adopt the new key and sync again. An interrupted rotation leaves
 * the vault `rotationPending`; calling this again starts over. A concurrent change seen by the
 * server restarts it automatically (up to three attempts).
 */
export async function runVaultRotation(
  queryClient: QueryClient,
  vaultId: string,
  report: (progress: RotationProgress) => void = () => undefined,
): Promise<void> {
  const attempts = 3;
  for (let i = 1; ; i++) {
    try {
      await attempt(queryClient, vaultId, report);
      return;
    } catch (error) {
      if (i >= attempts || !isRestartable(error)) throw error;
    }
  }
}

/** Revoke one item share, then rotate that item's key (two steps so a failed second one can be retried). */
export async function revokeItemShare(
  queryClient: QueryClient,
  itemId: string,
  shareId: string,
): Promise<void> {
  await api.delete(apiPaths.items.share(itemId, shareId), {
    schema: revokeItemShareResponseSchema,
  });
  await rotateItemKey(queryClient, itemId, shareId);
}

export async function rotateItemKey(
  queryClient: QueryClient,
  itemId: string,
  removedShareId: string,
): Promise<void> {
  await syncNow(queryClient);
  const { body } = await cryptoClient.call("prepareItemKeyRotation", { itemId, removedShareId });
  await api.put(apiPaths.items.item(itemId), { body, schema: updateItemResponseSchema });
  await syncNow(queryClient);
}
