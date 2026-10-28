import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Home } from "./home.tsx";
import { RootLayout } from "./root.tsx";

const rootRoute = createRootRoute({ component: RootLayout });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });

const routeTree = rootRoute.addChildren([homeRoute]);

export function createAppRouter(history?: Parameters<typeof createRouter>[0]["history"]) {
  return createRouter({ routeTree, history });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
