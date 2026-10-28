import { createRoute, redirect } from "@tanstack/react-router";
import { AdminLayout } from "../features/admin/AdminLayout.tsx";
import { InvitesTab } from "../features/admin/InvitesTab.tsx";
import { UsersTab } from "../features/admin/UsersTab.tsx";
import { appRoute } from "./app.tsx";
import { requireAdmin } from "./guards.ts";

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  beforeLoad: ({ context }) => requireAdmin(context.queryClient),
  component: AdminLayout,
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/admin/invites", replace: true });
  },
});

const invitesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/invites",
  component: InvitesTab,
});

const usersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/users",
  component: UsersTab,
});

export const adminRoutes = [adminRoute.addChildren([adminIndexRoute, invitesRoute, usersRoute])];
