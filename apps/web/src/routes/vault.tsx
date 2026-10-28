import { createRoute } from "@tanstack/react-router";
import { VaultPage } from "../features/vault/VaultPage.tsx";
import { appRoute } from "./app.tsx";

/**
 * Vault routes live under the app shell (`appRoute`), so they are only reachable when signed in
 * and unlocked. The vault UI work adds children here (`/vault/$vaultId`, `/item/$itemId`,
 * `/generator`, `/shared`) and lists them in `vaultRoutes`.
 */
export const vaultRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vault",
  component: VaultPage,
});

export const vaultRoutes = [vaultRoute];
