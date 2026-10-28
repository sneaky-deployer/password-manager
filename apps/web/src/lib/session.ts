import { apiPaths, logoutResponseSchema, type MeSummary, meResponseSchema } from "@pm/shared";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { cryptoClient } from "../crypto-worker/client.ts";
import { api } from "./api.ts";
import { startAutoLock } from "./auto-lock.ts";

// --- Lock state ----------------------------------------------------------------------------------

export type LockState = "locked" | "unlocked";

export interface LockStore {
  get(): LockState;
  set(state: LockState): void;
  subscribe(listener: () => void): () => void;
}

/** External store mirroring whether the crypto worker holds keys. A fresh page starts locked. */
export function createLockStore(initial: LockState = "locked"): LockStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const lockStore = createLockStore();

/** `locked | unlocked`, reactive. */
export function useLockState(): LockState {
  return useSyncExternalStore(lockStore.subscribe, lockStore.get, lockStore.get);
}

/** Call after the worker unlocked (login, unlock, account creation). */
export function markUnlocked(): void {
  lockStore.set("unlocked");
}

/** Wipe the worker's keys and mark the UI locked. The session cookie stays valid. */
export async function lockNow(): Promise<void> {
  lockStore.set("locked");
  try {
    await cryptoClient.call("lock");
  } catch {
    // A crashed worker has no keys either.
  }
}

// --- Session (GET /api/me) -----------------------------------------------------------------------

export const ME_QUERY_KEY = ["me"] as const;

/**
 * Top-level query key segments that survive a lock; every other query is removed on lock, because
 * it may hold decrypted data. Keep decrypted vault data out of `["me"]` and `["setup"]` keys.
 */
export const KEEP_ON_LOCK = new Set<string>(["me", "setup"]);

export function meQueryOptions() {
  return queryOptions({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get(apiPaths.me.root, { schema: meResponseSchema, signal, handleUnauthorized: false }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function setSessionUser(queryClient: QueryClient, user: MeSummary): void {
  queryClient.setQueryData(ME_QUERY_KEY, { user });
}

export interface SessionInfo {
  user: MeSummary | undefined;
  isLoading: boolean;
  isAdmin: boolean;
  lockState: LockState;
}

export function useSession(): SessionInfo {
  const query = useQuery(meQueryOptions());
  const lockState = useLockState();
  const user = query.data?.user;
  return { user, isLoading: query.isPending, isAdmin: user?.role === "admin", lockState };
}

/** The signed-in user. Only call below `AppShell`, which renders children only when a user exists. */
export function useRequiredUser(): MeSummary {
  const { user } = useSession();
  if (!user) throw new Error("useRequiredUser outside an authenticated page");
  return user;
}

/** Re-read `GET /me` (after 2FA or settings changes). */
export function refreshSession(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
}

/**
 * Sign out on the server, leave the signed-in pages, then wipe the keys and drop every cached
 * query. Navigating first matters: locking while the app shell is still mounted would make it
 * redirect to /unlock.
 */
export async function logout(
  queryClient: QueryClient,
  goToLogin: () => Promise<unknown>,
): Promise<void> {
  try {
    await api.post(apiPaths.auth.logout, {
      schema: logoutResponseSchema,
      handleUnauthorized: false,
    });
  } catch {
    // The cookie may already be invalid; local state is cleared either way.
  }
  await goToLogin();
  await lockNow();
  queryClient.clear();
}

// --- Auto-lock -----------------------------------------------------------------------------------

/** Locks after `minutes` without pointer/keyboard activity while mounted. */
export function useAutoLock(minutes: number | undefined): void {
  useEffect(() => {
    if (!minutes) return;
    return startAutoLock({ minutes, onLock: () => void lockNow() });
  }, [minutes]);
}

export function dropSensitiveQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => !KEEP_ON_LOCK.has(String(query.queryKey[0])),
  });
}
