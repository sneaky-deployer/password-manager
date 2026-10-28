import { apiPaths, syncResponseSchema } from "@pm/shared";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { cryptoClient } from "../../crypto-worker/client.ts";
import type { VaultSnapshot } from "../../crypto-worker/vault-protocol.ts";
import { api } from "../../lib/api.ts";

/**
 * Query keys of everything decrypted live under `["vault", ...]`, so the lock handler (which
 * removes every query except `"me"` and `"setup"`) drops them all.
 */
export const VAULT_QUERY_ROOT = ["vault"] as const;
export const VAULT_STATE_KEY = ["vault", "state"] as const;
export const PENDING_SHARES_KEY = ["vault", "pending"] as const;

/** Sync cadence while unlocked (PLAN.md 15): on focus and every 60 s. */
export const SYNC_INTERVAL_MS = 60_000;

export type VaultState = VaultSnapshot & {
  /** The server's clock at the start of the last sync, sent as the next `since`. */
  serverTime: number;
};

/** One `GET /sync` and its application in the worker. `since` comes from the previous result. */
async function doSync(queryClient: QueryClient): Promise<VaultState> {
  const previous = queryClient.getQueryData<VaultState>(VAULT_STATE_KEY);
  const response = await api.get(apiPaths.sync, {
    schema: syncResponseSchema,
    query: { since: previous?.serverTime },
  });
  const snapshot = await cryptoClient.call("applySync", { response });
  const state: VaultState = { ...snapshot, serverTime: response.serverTime };
  queryClient.setQueryData(VAULT_STATE_KEY, state);
  return state;
}

interface Slot {
  running: Promise<VaultState> | null;
  queued: Promise<VaultState> | null;
}
const slots = new WeakMap<QueryClient, Slot>();

/**
 * Single flight: one sync at a time per client. `fresh` guarantees the sync STARTS after this
 * call (use it after a write); otherwise an in-flight sync is joined.
 */
export function runSync(queryClient: QueryClient, fresh = false): Promise<VaultState> {
  let slot = slots.get(queryClient);
  if (!slot) {
    slot = { running: null, queued: null };
    slots.set(queryClient, slot);
  }
  const current = slot;
  if (!current.running) {
    const promise: Promise<VaultState> = doSync(queryClient).finally(() => {
      if (current.running === promise) current.running = null;
    });
    current.running = promise;
    return promise;
  }
  if (!fresh) return current.running;
  if (!current.queued) {
    current.queued = current.running
      .catch(() => undefined)
      .then(() => {
        current.queued = null;
        return runSync(queryClient, false);
      });
  }
  return current.queued;
}

/** Sync right now (after a local write, or from a "retry" button). */
export function syncNow(queryClient: QueryClient): Promise<VaultState> {
  return runSync(queryClient, true);
}

export function vaultStateOptions() {
  return queryOptions({
    queryKey: VAULT_STATE_KEY,
    queryFn: ({ client }) => runSync(client, false),
    staleTime: 10_000,
    refetchInterval: SYNC_INTERVAL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

/** The synced state (vaults, items, members, shares). The first load is the full sync. */
export function useVaultState() {
  return useQuery(vaultStateOptions());
}
