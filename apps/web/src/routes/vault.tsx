import { createRoute, Outlet, redirect } from "@tanstack/react-router";
import { InvitationsPage } from "../features/sharing/InvitationsPage.tsx";
import { Workspace } from "../features/vault/Workspace.tsx";
import { validateWorkspaceSearch } from "../features/vault/workspace-nav.tsx";
import { appRoute } from "./app.tsx";

/**
 * Vault routes live under the app shell (`appRoute`), so they are only reachable when signed in
 * and unlocked. The item list and its detail pane share one URL per scope; the open item and
 * editor mode are search params (`?item=<id>&mode=edit|new`).
 *
 *   /vault                   all items          /vault/v/:vaultId   one vault
 *   /vault/shared            shared with me     /vault/trash        trash
 *   /vault/invitations       pending invitations
 *   /item/:itemId            redirects to /vault?item=:itemId
 */
export const vaultRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vault",
  component: Outlet,
});

const allItemsRoute = createRoute({
  getParentRoute: () => vaultRoute,
  path: "/",
  validateSearch: validateWorkspaceSearch,
  component: () => <Workspace scope={{ kind: "all" }} />,
});

const vaultScopeRoute = createRoute({
  getParentRoute: () => vaultRoute,
  path: "/v/$vaultId",
  validateSearch: validateWorkspaceSearch,
  component: function VaultScope() {
    const { vaultId } = vaultScopeRoute.useParams();
    return <Workspace key={vaultId} scope={{ kind: "vault", vaultId }} />;
  },
});

const sharedRoute = createRoute({
  getParentRoute: () => vaultRoute,
  path: "/shared",
  validateSearch: validateWorkspaceSearch,
  component: () => <Workspace scope={{ kind: "shared" }} />,
});

const trashRoute = createRoute({
  getParentRoute: () => vaultRoute,
  path: "/trash",
  validateSearch: validateWorkspaceSearch,
  component: () => <Workspace scope={{ kind: "trash" }} />,
});

const invitationsRoute = createRoute({
  getParentRoute: () => vaultRoute,
  path: "/invitations",
  component: InvitationsPage,
});

const itemRedirectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/item/$itemId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/vault", search: { item: params.itemId }, replace: true });
  },
});

export const vaultRoutes = [
  vaultRoute.addChildren([
    allItemsRoute,
    vaultScopeRoute,
    sharedRoute,
    trashRoute,
    invitationsRoute,
  ]),
  itemRedirectRoute,
];
