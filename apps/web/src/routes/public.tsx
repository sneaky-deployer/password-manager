import { createRoute, redirect } from "@tanstack/react-router";
import { InvitePage } from "../features/auth/InvitePage.tsx";
import { LoginPage } from "../features/auth/LoginPage.tsx";
import { RecoverPage } from "../features/auth/RecoverPage.tsx";
import { SetupPage } from "../features/auth/SetupPage.tsx";
import { UnlockPage } from "../features/auth/UnlockPage.tsx";
import { lockStore } from "../lib/session.ts";
import { requireSession } from "./guards.ts";
import { rootRoute } from "./root.tsx";

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  component: InvitePage,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

export const recoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recover",
  component: RecoverPage,
});

/** Needs a session; already-unlocked users are sent on to the app. */
export const unlockRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/unlock",
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" ? { next: search.next } : {},
  beforeLoad: async ({ context, search }) => {
    await requireSession(context.queryClient);
    if (lockStore.get() === "unlocked") throw redirect({ to: search.next ?? "/vault" });
  },
  component: function Unlock() {
    const { next } = unlockRoute.useSearch();
    return <UnlockPage next={next} />;
  },
});
