import type { QueryClient } from "@tanstack/react-query";
import { cryptoClient } from "../crypto-worker/client.ts";
import { setUnauthorizedHandler } from "./api.ts";
import { dropSensitiveQueries, lockNow, lockStore } from "./session.ts";

/**
 * App-wide behaviour that ties modules together. Called once from `main.tsx`.
 * - 401 `unauthorized` on an authed call: wipe keys, clear the cache, go to /login.
 * - Lock: drop every cached query that may hold decrypted data (see `KEEP_ON_LOCK`).
 * - Crypto worker crash: the keys are gone, so the UI becomes locked.
 * - Page restored from the bfcache: lock (the worker may still hold keys).
 * Returns a cleanup function (used by tests).
 */
export function wireApp(queryClient: QueryClient, goToLogin: () => Promise<unknown>): () => void {
  let handlingUnauthorized = false;
  setUnauthorizedHandler(() => {
    if (handlingUnauthorized) return;
    handlingUnauthorized = true;
    // Leave the signed-in pages first, otherwise the app shell redirects to /unlock on lock.
    void goToLogin()
      .then(() => lockNow())
      .then(() => queryClient.clear())
      .finally(() => {
        handlingUnauthorized = false;
      });
  });
  const offLock = lockStore.subscribe(() => {
    if (lockStore.get() === "locked") dropSensitiveQueries(queryClient);
  });
  const offCrash = cryptoClient.onCrash(() => lockStore.set("locked"));
  // A page restored from the back/forward cache keeps its JS state, worker included: lock it.
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void lockNow();
  };
  window.addEventListener("pageshow", onPageShow);
  return () => {
    window.removeEventListener("pageshow", onPageShow);
    setUnauthorizedHandler(null);
    offLock();
    offCrash();
  };
}
