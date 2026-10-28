import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { adminRoutes } from "./admin.tsx";
import { appRoute, homeRoute } from "./app.tsx";
import { inviteRoute, loginRoute, recoverRoute, setupRoute, unlockRoute } from "./public.tsx";
import { rootRoute } from "./root.tsx";
import { settingsRoutes } from "./settings.tsx";
import { vaultRoutes } from "./vault.tsx";

const routeTree = rootRoute.addChildren([
  setupRoute,
  inviteRoute,
  loginRoute,
  recoverRoute,
  unlockRoute,
  appRoute.addChildren([homeRoute, ...vaultRoutes, ...settingsRoutes, ...adminRoutes]),
]);

export function createAppRouter(options: {
  queryClient: QueryClient;
  history?: Parameters<typeof createRouter>[0]["history"];
}) {
  return createRouter({
    routeTree,
    history: options.history,
    context: { queryClient: options.queryClient },
    defaultPreload: false,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
