import { apiPaths, pendingSharesResponseSchema } from "@pm/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { cryptoClient } from "../../crypto-worker/client.ts";
import type {
  ItemListView,
  ItemShareView,
  MemberView,
  VaultView,
} from "../../crypto-worker/vault-protocol.ts";
import { api } from "../../lib/api.ts";
import { filterItems, type ItemFilter } from "./filters.ts";
import { PENDING_SHARES_KEY, SYNC_INTERVAL_MS, useVaultState } from "./sync.ts";

const NONE: never[] = [];

/** All vaults I belong to, with decrypted names. */
export function useVaults() {
  const query = useVaultState();
  return {
    vaults: query.data?.vaults ?? (NONE as VaultView[]),
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Items matching `filter` (search, type, sort, scope), recomputed instantly on every change. */
export function useItems(filter: ItemFilter) {
  const query = useVaultState();
  const { search, type, sort } = filter;
  // The scope is an object built on every render; depend on its parts.
  const scopeKind = filter.scope.kind;
  const scopeVaultId = filter.scope.kind === "vault" ? filter.scope.vaultId : undefined;
  const all = query.data?.items ?? (NONE as ItemListView[]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is rebuilt from scopeKind/scopeVaultId
  const items = useMemo(
    () => filterItems(all, { scope: filter.scope, search, type, sort }),
    [all, scopeKind, scopeVaultId, search, type, sort],
  );
  return { items, all, isLoading: query.isPending, isError: query.isError, error: query.error };
}

/** One item: the list model from the sync plus the decrypted content (fetched from the worker). */
export function useItem(id: string | undefined) {
  const state = useVaultState();
  const summary = id ? state.data?.items.find((item) => item.id === id) : undefined;
  const detail = useQuery({
    queryKey: ["vault", "item", id, summary?.revision, summary?.updatedAt],
    queryFn: () => cryptoClient.call("getItem", { id: id as string }),
    enabled: Boolean(summary),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30_000,
    // A revision bump (an edit, a key rotation after revoking a share, a sync of someone else's
    // change) changes the key and refetches. Keep showing the same item's previous content while
    // that runs: otherwise the whole detail pane swaps to a spinner and unmounts its open dialogs
    // (e.g. the share dialog loses its "revoked" notice). Never carry content over to ANOTHER item.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === id ? previous : undefined,
  });
  return {
    summary,
    detail: detail.data,
    isLoading: state.isPending || (Boolean(summary) && detail.isPending),
    notFound: !state.isPending && !summary,
    error: detail.error,
  };
}

export function useMembers(vaultId: string | undefined): MemberView[] {
  const state = useVaultState();
  const members = state.data?.members;
  return useMemo(
    () => (members ?? []).filter((member) => member.vaultId === vaultId),
    [members, vaultId],
  );
}

export function useItemShares(itemId: string | undefined): ItemShareView[] {
  const state = useVaultState();
  const shares = state.data?.itemShares;
  return useMemo(() => (shares ?? []).filter((share) => share.itemId === itemId), [shares, itemId]);
}

/** Invitations waiting for me (`GET /shares/pending`). Ciphertext only; names are opened on demand. */
export function usePendingShares() {
  return useQuery({
    queryKey: PENDING_SHARES_KEY,
    queryFn: ({ signal }) =>
      api.get(apiPaths.shares.pending, { schema: pendingSharesResponseSchema, signal }),
    refetchInterval: SYNC_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}
