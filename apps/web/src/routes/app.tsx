import { createRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "../features/shell/AppShell.tsx";
import { requireUnlocked } from "./guards.ts";
import { rootRoute } from "./root.tsx";

/**
 * Pathless layout route for everything behind the lock: unauthenticated users go to /login,
 * locked ones to /unlock. Children (vault, settings, admin) render inside `AppShell`.
 */
export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: ({ context, location }) => requireUnlocked(context.queryClient, location),
  component: AppShell,
});

export const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/vault", replace: true });
  },
});
