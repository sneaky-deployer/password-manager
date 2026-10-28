import type { MeSummary } from "@pm/shared";
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { isApiError } from "../lib/api.ts";
import { lockStore, meQueryOptions } from "../lib/session.ts";

/** Resolves the signed-in user or redirects to /login. */
export async function requireSession(queryClient: QueryClient): Promise<MeSummary> {
  try {
    const { user } = await queryClient.ensureQueryData(meQueryOptions());
    return user;
  } catch (error) {
    if (isApiError(error) && error.status === 401) throw redirect({ to: "/login" });
    throw error;
  }
}

/** Signed in and unlocked, else /login or /unlock (remembering where the user wanted to go). */
export async function requireUnlocked(
  queryClient: QueryClient,
  location: { pathname: string; searchStr: string },
): Promise<MeSummary> {
  const user = await requireSession(queryClient);
  if (lockStore.get() === "locked") {
    throw redirect({ to: "/unlock", search: { next: location.pathname + location.searchStr } });
  }
  return user;
}

export async function requireAdmin(queryClient: QueryClient): Promise<MeSummary> {
  const user = await requireSession(queryClient);
  if (user.role !== "admin") throw redirect({ to: "/vault" });
  return user;
}
